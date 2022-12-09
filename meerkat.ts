import nacl from 'tweetnacl';
import type { SignKeyPair, BoxKeyPair } from 'tweetnacl';
import bs58check from 'bs58check';
import { Buffer } from 'buffer';
import WebTorrent from 'webtorrent';
import type {
  Wire,
  ExtensionConstructor,
  Extension,
} from 'bittorrent-protocol';
import bs58 from 'bs58';
import ripemd160 from 'ripemd160';
import type { MeerkatParameters, Packet, Peer } from './types';
import EventEmitter from 'events';
import {
  encode as bencode_encode,
  decode as bencode_decode,
} from './lib/bencode';

const PEER_TIMEOUT = 5 * 60 * 1000;
const EXT = 'bo_channel';

export default class Meerkat extends EventEmitter {
  announce: Array<String>;
  webTorrent: any;
  seed: string;
  torrent: any = null;
  torrentCreated: boolean = false;
  keyPair: SignKeyPair;
  keyPairEncrypt: BoxKeyPair;
  publicKey: string;
  encryptedPublicKey: string;
  identifier: string;
  peers: { [key: string]: Peer } = {};
  seen: { [key: string]: number } = {};
  lastwirecount: any;
  api: { [key: string]: Function } = {};
  callbacks: { [key: string]: Function } = {};
  serveraddress: any = null;
  heartbeattimer: any = null;

  constructor(parameters: MeerkatParameters = {}) {
    super();
    const { identifier, announce, seed } = parameters;

    this.announce = announce || [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.tracker.cl:1337/announce',
      'udp://opentracker.i2p.rocks:6969/announce',
      'https://opentracker.i2p.rocks:443/announce',
      'wss://tracker.files.fm:7073/announce',
      'wss://spacetradersapi-chatbox.herokuapp.com:443/announce',
      'ws://tracker.files.fm:7072/announce',
    ];
    this.seed = seed || this.encodeseed(nacl.randomBytes(32));

    this.keyPair = nacl.sign.keyPair.fromSeed(
      Uint8Array.from(bs58check.decode(this.seed)).slice(2)
    );
    this.keyPairEncrypt = nacl.box.keyPair();

    this.publicKey = bs58.encode(Buffer.from(this.keyPair.publicKey));
    this.encryptedPublicKey = bs58.encode(
      Buffer.from(this.keyPairEncrypt.publicKey)
    );

    this.identifier = identifier || this.address();
    this.lastwirecount = null;

    this.webTorrent = new WebTorrent({});
    console.log('meerkat identifier', this.identifier);

    this.torrent = this.webTorrent.seed(
      Buffer.from(this.identifier),
      {
        name: this.identifier,
        announce: this.announce,
      },
      () => {
        this.emit('torrent', this.identifier, this.torrent);
        if (this.torrent.discovery.tracker) {
          this.torrent.discovery.tracker.on('update', (update: any) => {
            this.emit('tracker', this.identifier, update);
          });
        }
        this.torrent.discovery.on('trackerAnnounce', () => {
          this.emit('announce', this.identifier);
          this.connections();
        });
      }
    );
    this.torrentCreated = true;
    this.torrent.on('wire', (wire: Wire) => this.attach(wire));
  }

  attach(wire: Wire) {
    wire.use(this.extension(wire));
    wire.on('close', () => this.detach(wire));
  }

  detach(wire: Wire) {
    this.emit('wireleft', this.torrent.wires.length, wire);
    this.connections();
  }

  extension(wire: Wire): ExtensionConstructor {
    const WireExtension: any = function (this: any, wire: Wire) {
      this.wire = wire;
      this.name = EXT;
    };

    wire.extendedHandshake.identifier = this.identifier;
    wire.extendedHandshake.publicKey = this.publicKey;
    wire.extendedHandshake.encryptedPublicKey = this.encryptedPublicKey;

    const wireExtension: any = new WireExtension(wire);

    wireExtension.onExtendedHandshake = (handshake: { [key: string]: any }) =>
      this.onExtendedHandshake(wire, handshake);
    wireExtension.onMessage = (buffer: Buffer) => this.onMessage(buffer);

    return wireExtension;
  }

  onMessage(message: Buffer) {
    const hash = Meerkat.toHex(nacl.hash(message).slice(16));
    const now = new Date().getTime();

    if (!this.seen[hash]) {
      let unpacked: Packet | null = bencode_decode(message);

      if (unpacked.e && unpacked.n && unpacked.ek) {
        var ek = unpacked.ek.toString();

        var decrypted = nacl.box.open(
          unpacked.e,
          unpacked.n,
          bs58.decode(ek),
          this.keyPairEncrypt.secretKey
        );

        if (decrypted) {
          unpacked = bencode_decode(decrypted);
        } else {
          unpacked = null;
        }
      }

      if (unpacked && unpacked.p && unpacked.s) {
        const packet = bencode_decode(unpacked.p);
        if (
          typeof packet.pk !== 'undefined' &&
          typeof packet.ek !== 'undefined' &&
          typeof packet.t !== 'undefined' &&
          typeof packet.i !== 'undefined'
        ) {
          const pk = packet.pk.toString();
          const id = packet.i.toString();

          const checksig = nacl.sign.detached.verify(
            unpacked.p,
            unpacked.s,
            bs58.decode(pk)
          );
          const checkid = id === this.identifier;
          const checktime = packet.t + PEER_TIMEOUT > now;

          if (checksig && checkid && checktime) {
            const ek = packet.ek.toString();
            this.sawPeer(pk, ek);

            if (packet.y == 'm') {
              const messagestring = packet.v.toString();
              const messagejson = null;
              try {
                const messagejson = JSON.parse(messagestring);
              } catch (e) {
                console.warn(e);
              }
              if (messagejson) {
                this.emit('message', this.address(pk), messagejson, packet);
              }
            } else if (packet.y == 'r') {
              // rpc call
              const call = packet.c.toString();
              const argsstring = packet.a.toString();
              let args: { [key: string]: any } | null;
              try {
                args = JSON.parse(argsstring);
              } catch (e) {
                args = null;
                console.warn('Malformed args JSON: ' + argsstring);
              }
              const nonce = packet.rn || new Uint8Array();
              this.emit(
                'rpc',
                this.address(pk),
                call,
                args,
                Meerkat.toHex(nonce)
              );
              // make the API call and send back response
              this.rpcCall(pk, call, args, nonce);
            } else if (packet.y === 'rr') {
              // rpc response
              const nonce = Meerkat.toHex(packet.rn);
              if (this.callbacks[nonce]) {
                let responsestring: string = '';
                let responsestringstruct:
                  | { [key: string]: any }
                  | undefined
                  | null;

                if (typeof packet['rr'] !== 'undefined') {
                  responsestring = packet.rr.toString();
                } else {
                  console.warn('Empty rr in rpc response.');
                }

                try {
                  responsestringstruct = JSON.parse(responsestring);
                } catch (e) {
                  console.warn('Malformed response JSON: ' + responsestring);
                  responsestringstruct = null;
                }

                if (this.callbacks[nonce] && responsestringstruct) {
                  console.warn(
                    'rpc-response',
                    this.address(pk),
                    nonce,
                    responsestringstruct
                  );
                  this.emit(
                    'rpc-response',
                    this.address(pk),
                    nonce,
                    responsestringstruct
                  );
                  this.callbacks[nonce](responsestringstruct);
                  delete this.callbacks[nonce];
                } else {
                  console.warn('RPC response nonce not known:', nonce);
                }
              } else {
                console.warn('dropped response with no callback.', nonce);
              }
            } else if (packet.y === 'p') {
              const address = this.address(pk);
              console.warn('ping from', address);
              this.emit('ping', address);
            } else if (packet.y === 'x') {
              const address = this.address(pk);
              console.warn('got left from', address);
              delete this.peers[address];
              this.emit('left', address);
            } else {
              // TODO: handle ping/keep-alive message
              console.warn('unknown packet type');
            }
          } else {
            console.warn(
              'dropping bad packet',
              hash,
              checksig,
              checkid,
              checktime
            );
          }
        } else {
          console.warn('skipping packet with no payload', hash, unpacked);
        }
      } else {
        console.warn('packet has missing mandatory fields', hash, unpacked);
      }
      // forward first-seen message to all connected wires
      // TODO: block flooders
      this.sendRaw(message);
    } else {
      console.log('already seen', hash);
    }
    // refresh last-seen timestamp on this message
    this.seen[hash] = now;
  }

  onExtendedHandshake(wire: Wire, handshake: { [key: string]: any }) {
    this.emit('wireseen', this.torrent.wires.length, wire);
    this.connections();
    // TODO: check sig and drop on failure - wire.peerExtendedHandshake
    this.sawPeer(handshake.pk.toString(), handshake.ek.toString());
  }

  register(name: string, callback: Function) {
    this.api[name] = callback;
  }

  rpc(
    address: string,
    call: string,
    args: { [key: string]: any },
    callback: Function
  ) {
    if (this.peers[address]) {
      const publicKey = this.peers[address].publicKey;
      var callnonce = nacl.randomBytes(8);
      this.callbacks[Meerkat.toHex(callnonce)] = callback;
      this.makeEncryptSendPacket(publicKey, {
        y: 'r',
        c: call,
        a: JSON.stringify(args),
        rn: callnonce,
      });
    } else {
      throw address + ' not seen - no public key.';
    }
  }

  rpcCall(
    publicKey: string,
    call: string,
    args: { [key: string]: any } | null,
    nonce: Uint8Array
  ) {
    const packet = { y: 'rr', rn: nonce, rr: '' };
    if (this.api[call]) {
      this.api[call](this.address(publicKey), args, (result: Object) => {
        packet['rr'] = JSON.stringify(result);
        this.makeEncryptSendPacket(publicKey, packet);
      });
    } else {
      packet['rr'] = JSON.stringify({ error: 'No such API call.' });
      this.makeEncryptSendPacket(publicKey, packet);
    }
  }

  makeEncryptSendPacket(publicKey: string, packetObject: Object) {
    const packet = this.makePacket(packetObject);
    const encryptedPacket = this.encryptPacket(publicKey, packet);
    this.sendRaw(encryptedPacket);
  }

  encryptPacket(publicKey: string, packet: Buffer) {
    if (this.peers[this.address(publicKey)]) {
      var nonce = nacl.randomBytes(nacl.box.nonceLength);
      packet = bencode_encode({
        n: nonce,
        ek: bs58.encode(Buffer.from(this.keyPairEncrypt.publicKey)),
        e: nacl.box(
          packet,
          nonce,
          bs58.decode(this.peers[this.address(publicKey)].encryptedPublicKey),
          this.keyPairEncrypt.secretKey
        ),
      });
    } else {
      throw this.address(publicKey) + ' not seen - no encryption key.';
    }
    return packet;
  }

  sawPeer(publicKey: string, encryptedPublicKey: string) {
    var now = new Date().getTime();
    var address = this.address(publicKey);
    // ignore ourself
    if (address != this.address()) {
      // if we haven't seen this peer for a while
      if (
        !this.peers[address] ||
        this.peers[address].last + PEER_TIMEOUT < now
      ) {
        this.peers[address] = {
          encryptedPublicKey: encryptedPublicKey,
          publicKey: publicKey,
          last: now,
        };

        this.emit('seen', this.address(publicKey));
        if (this.address(publicKey) == this.identifier) {
          this.serveraddress = address;
          this.emit('server', this.address(publicKey));
        }
        // send a ping out so they know about us too
        var packet = this.makePacket({ y: 'p' });
        this.sendRaw(packet);
      } else {
        this.peers[address].encryptedPublicKey = encryptedPublicKey;
        this.peers[address].last = new Date().getTime();
      }
    }
  }

  connections() {
    if (this.torrent.wires.length != this.lastwirecount) {
      this.lastwirecount = this.torrent.wires.length;
      this.emit('connections', this.torrent.wires.length);
    }
    return this.lastwirecount;
  }

  close() {
    const packet = this.makePacket({ y: 'x' });
    this.sendRaw(packet);

    if (typeof this.webTorrent !== 'undefined' && this.torrentCreated) {
      this.webTorrent.remove(this.torrent);
    }
  }

  private sendRaw(message: Buffer) {
    const wires = this.torrent.wires;
    for (const wire of wires) {
      const extendedhandshake = wire['peerExtendedHandshake'];
      if (
        extendedhandshake &&
        extendedhandshake.m &&
        extendedhandshake.m[EXT]
      ) {
        wire.extended(EXT, message);
      }
    }
  }

  private static toHex(uint8Array?: Uint8Array) {
    if (typeof uint8Array === 'undefined') {
      return '';
    }
    return Buffer.from(uint8Array).toString('hex');
  }

  private makePacket(params: object) {
    const packet = {
      ...params,
      t: new Date().getTime(),
      i: this.identifier,
      pk: this.publicKey,
      ek: this.encryptedPublicKey,
      n: nacl.randomBytes(8),
    };

    const encodedPacket = bencode_encode(packet);
    return bencode_encode({
      s: nacl.sign.detached(encodedPacket, this.keyPair.secretKey),
      p: packet,
    });
  }

  encodeAddress(address: Uint8Array) {
    const ADDRESSPREFIX = '55';

    return bs58check.encode(
      Buffer.concat([
        Buffer.from(ADDRESSPREFIX, 'hex'),
        new ripemd160().update(Buffer.from(nacl.hash(address))).digest(),
      ])
    );
  }

  address(publicKey?: string) {
    let decodedPublicKey: Uint8Array;
    if (typeof publicKey == 'string') {
      decodedPublicKey = bs58.decode(publicKey);
    } else {
      decodedPublicKey = this.keyPair.publicKey;
    }
    return this.encodeAddress(decodedPublicKey);
  }

  heartbeat(heartbeat: any) {
    throw new Error('Method not implemented.');
  }

  encodeseed(randomBytes: Uint8Array): string {
    const SEEDPREFIX = '490a';

    return bs58check.encode(
      Buffer.concat([Buffer.from(SEEDPREFIX, 'hex'), Buffer.from(randomBytes)])
    );
  }
}
