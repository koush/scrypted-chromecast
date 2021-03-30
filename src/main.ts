'use strict';

import util from 'util';
import sdk, { Device, DeviceProvider, MediaObject, MediaPlayer, MediaPlayerOptions, MediaPlayerState, MediaStatus, Notifier, Refresh, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';
import { EventEmitter } from 'events';
import memoizeOne from 'memoize-one';
import mdns from 'mdns';

const { mediaManager, deviceManager, log } = sdk;
const { DefaultMediaReceiver } = require('castv2-client');
const Client = require('castv2-client').Client;

function ScryptedMediaReceiver() {
  DefaultMediaReceiver.apply(this, arguments);
}
ScryptedMediaReceiver.APP_ID = '9E3714BD';
util.inherits(ScryptedMediaReceiver, DefaultMediaReceiver);

const audioFetch = (body) => {
  var buf = Buffer.from(body);
  var mo = mediaManager.createMediaObject(buf, 'text/plain');
  return mediaManager.convertMediaObjectToInsecureLocalUrl(mo, 'audio/*');
}
// memoize this text conversion, as announcements going to multiple speakers will
// trigger multiple text to speech conversions.
// this is a simple way to prevent thrashing by waiting for the single promise.
var memoizeAudioFetch = memoizeOne(audioFetch);

// castv2 makes the the assumption that protobufjs returns Buffers, which is does not. It returns ArrayBuffers
// in the quickjs environment.
function toBuffer(buffer) {
  if (buffer && (buffer.constructor.name === ArrayBuffer.name || buffer.constructor.name === Uint8Array.name)) {
    var ret = Buffer.from(buffer);
    return ret;
  }
  return buffer;
}
const BufferConcat = Buffer.concat;
Buffer.concat = function (bufs) {
  var copy = [];
  for (var buf of bufs) {
    copy.push(toBuffer(buf));
  }
  return BufferConcat(copy);
}

class CastDevice extends ScryptedDeviceBase implements Notifier, MediaPlayer, Refresh {
  provider: CastDeviceProvider;
  host: any;
  device: Device;
  port: number;

  constructor(provider: CastDeviceProvider, nativeId: string) {
    super(nativeId);
    this.provider = provider;
  }

  currentApp: string;
  playerPromise: Promise<any>;
  connectPlayer(app: string): Promise<any> {
    if (this.playerPromise) {
      if (this.currentApp === app) {
        return this.playerPromise;
      }

      this.playerPromise.then(player => {
        player.removeAllListeners();
        player.close();
      });
      this.playerPromise = undefined;
    }

    this.currentApp = app;
    return this.playerPromise = this.connectClient()
      .then(client => {
        return new Promise((resolve, reject) => {
          this.log.i('launching');
          client.launch(app, (err, player) => {
            if (err) {
              reject(err);
              return;
            }

            player.on('close', () => {
              this.log.i('player closed');
              player.removeAllListeners();
              this.playerPromise = undefined;
            });

            this.log.i('player launched.');
            resolve(player);
          });
        });
      })
      .catch(err => {
        this.playerPromise = undefined;
        throw err;
      });
  }

  clientPromise: Promise<any>;
  connectClient(): Promise<any> {
    if (this.clientPromise) {
      return this.clientPromise;
    }

    var promise;
    var resolved = false;
    return this.clientPromise = promise = new Promise((resolve, reject) => {
      var client = new Client();
      client.on('error', err => {
        this.log.i(`Client error: ${err.message}`);
        client.removeAllListeners();
        client.close();
        if (this.clientPromise === promise) {
          this.clientPromise = undefined;
        }
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      client.on('status', async status => {
        this.log.i(JSON.stringify(status));
        await this.joinPlayer();
      })
      client.connect(this.host, () => {
        this.log.i(`client connected.`);
        resolved = true;
        resolve(client);
      });
    })
  }

  async sendMediaToClient(title, mediaUrl, mimeType, opts?) {
    var media = {
      // Here you can plug an URL to any mp4, webm, mp3 or jpg file with the proper contentType.
      contentId: mediaUrl,
      contentType: mimeType,
      streamType: 'BUFFERED', // or LIVE

      // Title and cover displayed while buffering
      metadata: {
        type: 0,
        metadataType: 0,
        title: title,
      },

      // these are internal APIs. TODO: make them public.
      customData: {
        senderId: pushManager.getSenderId(),
        registrationId: pushManager.getRegistrationId(),
      }
    };

    var app;
    if (!mediaUrl.startsWith('http')) {
      app = ScryptedMediaReceiver;
    }
    else {
      app = DefaultMediaReceiver;
    }

    opts = opts || {
      autoplay: true,
    }

    const player = await this.connectPlayer(app)
    player.load(media, opts, (err, status) => {
      if (err) {
        this.log.e(`load error: ${err}`);
        return;
      }
      this.log.i(`media loaded playerState=${status.playerState}`);
    });
  }

  async load(media: MediaObject, options: MediaPlayerOptions) {
    // the mediaManager is provided by Scrypted and can be used to convert
    // MediaObjects into other objects.
    // For example, a MediaObject from a RTSP camera can be converted to an externally
    // accessible Uri png image using mediaManager.convert.
    const result = await mediaManager.convertMediaObjectToUrl(media, null)
    this.sendMediaToClient(options && (options as any).title, result, media.mimeType);
  }

  static CastInactive = new Error('Media player is inactive.');
  mediaPlayerPromise: Promise<any>;
  mediaPlayerStatus: any;
  joinPlayer() {
    if (this.mediaPlayerPromise) {
      return this.mediaPlayerPromise;
    }

    this.log.i('attempting to join session2');
    return this.mediaPlayerPromise = this.connectClient()
      .then(client => {
        this.log.i('attempting to join session');
        return new Promise((resolve, reject) => {
          client.getSessions((err, applications) => {
            if (err) {
              reject(err);
              return;
            }

            if (!applications || !applications.length) {
              this.mediaPlayerStatus = undefined;
              this.updateState();
              reject(CastDevice.CastInactive);
              return;
            }
            client.join(applications[0], DefaultMediaReceiver, (err, player) => {
              if (err) {
                reject(err);
                return;
              }

              player.on('close', () => {
                this.log.i('player closed');
                player.removeAllListeners();
                this.mediaPlayerPromise = undefined;
                this.mediaPlayerStatus = undefined;
                this.updateState();
              });

              player.on('status', () => {
                player.getStatus((err, status) => {
                  if (err) {
                    return;
                  }
                  this.mediaPlayerStatus = status;
                  this.updateState();
                });
              })

              player.getStatus((err, status) => {
                if (err) {
                  reject(err);
                  return;
                }
                this.mediaPlayerStatus = status;
                this.updateState();
                resolve(player);
              })
            });
          });
        });
      })
      .catch(e => {
        this.log.e(`Error connecting to current session ${e}`);
        this.mediaPlayerPromise = undefined;
        throw e;
      })
  }

  async start() {
    const player = await this.joinPlayer();
    player.start();
  }
  async pause() {
    const player = await this.joinPlayer();
    player.pause();
  }
  parseState(): MediaPlayerState {
    if (!this.mediaPlayerStatus) {
      return MediaPlayerState.Idle;
    }
    switch (this.mediaPlayerStatus.playerState) {
      case "PLAYING":
        return MediaPlayerState.Playing;
      case "PAUSED":
        return MediaPlayerState.Paused;
      case "IDLE":
        return MediaPlayerState.Idle;
      case "BUFFERING":
        return MediaPlayerState.Buffering;
    }
  }

  stateTimestamp: number;
  updateState() {
    this.stateTimestamp = Date.now();
    const mediaPlayerStatus = this.getMediaStatus();
    switch (mediaPlayerStatus.mediaPlayerState) {
      case MediaPlayerState.Idle:
        this.running = false;
        break;
      case MediaPlayerState.Paused:
      case MediaPlayerState.Buffering:
      case MediaPlayerState.Playing:
      default:
        this.running = true;
        break;
    }
    this.paused = mediaPlayerStatus.mediaPlayerState === MediaPlayerState.Paused;
    deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.MediaPlayer, mediaPlayerStatus);
  }
  getMediaStatus(): MediaStatus {
    var mediaPlayerState: MediaPlayerState = this.parseState();
    const media = this.mediaPlayerStatus && this.mediaPlayerStatus.media;
    const metadata = media && media.metadata;
    let position = this.mediaPlayerStatus && this.mediaPlayerStatus.currentTime;
    if (position) {
      position += (Date.now() - this.stateTimestamp) / 1000;
    }
    return {
      mediaPlayerState,
      duration: media && media.duration,
      position,
      metadata,
    };
  }
  async seek(milliseconds: number) {
    const player = await this.joinPlayer();
    player.seek(milliseconds);
  }
  async resume() {
    const player = await this.joinPlayer();
    player.play();
  }
  async stop() {
    const player = await this.joinPlayer();
    player.stop();
  }
  async skipNext() {
    const player = await this.joinPlayer();
    player.media.sessionRequest({ type: 'QUEUE_NEXT' });
  }
  async skipPrevious() {
    const player = await this.joinPlayer();
    player.media.sessionRequest({ type: 'QUEUE_PREV' });
  }

  sendNotificationToHost(title, body, media, mimeType) {
    if (!media || this.type == 'Speaker') {
      log.i('fetching audio: ' + body);
      memoizeAudioFetch(body)
        .then(result => {
          this.log.i(`sending audio ${result}`);
          this.sendMediaToClient(title, result, 'audio/*');
        })
        .catch(e => {
          this.log.e(`error memoizing audio ${e}`);
          // do not cache errors.
          memoizeAudioFetch = memoizeOne(audioFetch);
        });
      return;
    }

    mediaManager.convertMediaObjectToUrl(media, null)
      .then(result => {
        this.log.i(`url: ${result}`);
        this.sendMediaToClient(title, result, mimeType);
      });
  }

  sendNotification(title, body, media, mimeType) {
    if (!this.device) {
      this.provider.search.removeAllListeners(this.id);
      this.provider.search.once(this.id, () => this.sendNotificationToHost(title, body, media, mimeType));
      this.provider.discoverDevices(30000);
      return;
    }

    setImmediate(() => this.sendNotificationToHost(title, body, media, mimeType));
  }
  async getRefreshFrequency(): Promise<number> {
    return 60;
  }
  refresh(refreshInterface: string, userInitiated: boolean): void {
    this.joinPlayer()
      .catch(() => { });
  }
}

class CastDeviceProvider extends ScryptedDeviceBase implements DeviceProvider {
  devices: any = {};
  search = new EventEmitter();
  browser = mdns.createBrowser(mdns.tcp('googlecast'));
  searching: boolean;

  constructor() {
    super(null);

    this.browser.on('serviceUp', (service) => {
      this.log.i(JSON.stringify(service));
      var id = service.txtRecord.id;
      if (!id) {
        // wtf?
        return;
      }
      var model = service.txtRecord.md;
      var name = service.txtRecord.fn;
      var type = (model && model.indexOf('Google Home') != -1 && model.indexOf('Hub') == -1) ? ScryptedDeviceType.Speaker : ScryptedDeviceType.Display;

      var interfaces = ['Notifier', 'MediaPlayer', 'Refresh', 'StartStop', 'Pause',];

      var device: Device = {
        nativeId: id,
        name,
        model,
        type,
        interfaces,
        metadata: {
          syncWithIntegrations: false,
          syncWithGoogle: false,
        },
      };

      const host = service.addresses[0];
      const port = service.port;


      this.log.i(`found cast device: ${name}`);

      var castDevice = this.devices[id] || (this.devices[id] = new CastDevice(this, device.nativeId));
      castDevice.device = device;
      castDevice.host = host;
      castDevice.port = port;

      this.search.emit(id);
      deviceManager.onDeviceDiscovered(device);
    });

    this.discoverDevices(30000);
  }

  getDevice(nativeId: string) {
    return this.devices[nativeId] || (this.devices[nativeId] = new CastDevice(this, nativeId));
  }

  discoverDevices(duration: number) {
    if (this.searching) {
      return;
    }
    this.searching = true;
    duration = duration || 10000;
    setTimeout(() => {
      this.searching = false;
      this.browser.stop();
    }, duration)

    this.browser.start();
  }
}


export default new CastDeviceProvider();