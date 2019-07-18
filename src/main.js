const fs = require('fs');
const util = require('util');
import { resolve } from 'path';
fs.registerFile(resolve('../node_modules/castv2/lib/cast_channel.proto'), require('raw-loader!../node_modules/castv2/lib/cast_channel.proto'))

const mdns = require('mdns');
import EventEmitter from 'events';
const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
import memoizeOne from 'memoize-one';

import sdk from '@scrypted/sdk';
const { mediaManager, log } = sdk;

function ScryptedMediaReceiver() {
  DefaultMediaReceiver.apply(this, arguments);
}
ScryptedMediaReceiver.APP_ID = '9E3714BD';
util.inherits(ScryptedMediaReceiver, DefaultMediaReceiver);


function CastDevice(provider, id) {
  this.provider = provider;
  this.id = id;
}

CastDevice.prototype.sendMediaToClient = function (title, mediaUrl, mimeType, opts) {
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

    customData: {
      senderId: pushManager.getSenderId(),
      registrationId: pushManager.getRegistrationId(),
    }
  };

  var app;
  var appId;
  if (!mediaUrl.startsWith('http')) {
    app = ScryptedMediaReceiver;
  }
  else {
    app = DefaultMediaReceiver;
  }
  appId = app.APP_ID;
  
  opts = opts || {
    autoplay: true,
  }

  var load = () => {
    this.player.load(media, opts, function (err, status) {
      if (err) {
        log.e(`load error: ${err}`);
        return;
      }
      log.i(`media loaded playerState=${status.playerState}`);
    });
  };

  if (this.player) {
    if (this.player.appId == appId) {
      load();
      return;
    }
    this.player.close();
    delete this.player;
  }

  this.client.launch(app, (err, player) => {
    this.player = player;
    this.player.appId = appId;
    this.player.on('status', function (status) {
      if (err) {
        log.e(`status error: ${err}`);
        return;
      }
      log.i(`status broadcast playerState=${status.playerState}`);
    });
    this.player.on('close', () => {
      log.i('player closed');
      delete this.player;
      if (this.client) {
        this.client.close();
        delete this.client;
      }
    });

    log.i(`app "${player.session.displayName}" launched, loading media ${media.contentId} ...`);
    load();
  });
}

CastDevice.prototype.load = function(media, options) {
  // the mediaManager is provided by Scrypted and can be used to convert
  // MediaObjects into other objects.
  // For example, a MediaObject from a RTSP camera can be converted to an externally
  // accessible Uri png image using mediaManager.convert.
  mediaManager.convertMediaObjectToUri(media)
  .then(result => {
    this.sendMedia(options && options.title, result, media.mimeType, options);
  });
}

CastDevice.prototype.play = function() {
  if (this.player)
    this.player.play();
}

CastDevice.prototype.pause = function() {
  if (this.player)
    this.player.pause();
}

CastDevice.prototype.stop = function() {
  if (this.player)
    this.player.stop();
}

CastDevice.prototype.sendMedia = function (title, mediaUrl, mimeType) {
  if (this.client) {
    log.i('reusing client')
    this.sendMediaToClient(title, mediaUrl, mimeType);
    return;
  }

  this.client = new Client();

  this.client.connect(this.host, () => {
    this.sendMediaToClient(title, mediaUrl, mimeType);
  });

  this.client.on('error', (err) => {
    log.i(`Error: ${err.message}`);
    delete this.player;
    if (this.client) {
      this.client.close();
      delete this.client;
    }
  });
}

const audioFetch = (body) => {
  var buf = Buffer.from(body);
  var mo  = mediaManager.createMediaObject(buf, 'text/plain');
  console.log(mo.toString());
  return mediaManager.convertMediaObjectToUri(mo, 'audio/*');
}
// memoize this text conversion, as announcements going to multiple speakers will
// trigger multiple text to speech conversions.
// this is a simple way to prevent thrashing by waiting for the single promise.
var memoizeAudioFetch = memoizeOne(audioFetch);

CastDevice.prototype.sendNotificationToHost = function (title, body, media, mimeType) {
  if (!media || this.device.type == 'Speaker') {
    audioFetch(body)
      .then(result => {
        this.sendMedia(title, result.toString(), 'audio/*');
      })
      .catch(e => {
        log.e(`error memoizing audio ${e}`);
        // do not cache errors.
        memoizeAudioFetch = memoizeOne(audioFetch);
      });
    return;
  }

  mediaManager.convertMediaObjectToUri(media)
    .then(result => {
      this.sendMedia(title, result, mimeType);
    });
}

CastDevice.prototype.sendNotification = function (title, body, media, mimeType) {
  if (!this.device) {
    this.provider.search.removeAllListeners(this.id);
    this.provider.search.once(this.id, () => this.sendNotificationToHost(title, body, media, mimeType));
    this.provider.discoverDevices(30000);
    return;
  }

  setImmediate(() => this.sendNotificationToHost(title, body, media, mimeType));
}

function DeviceProvider() {
  this.devices = {};
  this.search = new EventEmitter();
  this.browser = mdns.createBrowser(mdns.tcp('googlecast'));

  this.browser.on('serviceUp', function(service) {
    log.i(JSON.stringify(service));
    var id = service.txtRecord.id;
    if (!id) {
      // wtf?
      return;
    }
    var model = service.txtRecord.md;
    var name = service.txtRecord.fn;
    var type = (model && model.indexOf('Google Home') != -1 && model.indexOf('Hub') == -1) ? 'Speaker' : 'Display';

    var interfaces = ['Notifier', 'MediaPlayer'];

    var device = {
      nativeId: id,
      name,
      model,
      type,
      interfaces,
    };

    var host = service.addresses[0];

    log.i(`found cast device: ${name}`);

    var castDevice = this.devices[id] || (this.devices[id] = new CastDevice(this, id));
    castDevice.device = device;
    castDevice.host = host;

    this.search.emit(id);
    deviceManager.onDeviceDiscovered(device);
  }.bind(this));

  this.discoverDevices(30000);
}

DeviceProvider.prototype.getDevice = function (id) {
  return this.devices[id] || (this.devices[id] = new CastDevice(this, id));
}

DeviceProvider.prototype.discoverDevices = function (duration) {
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


export default new DeviceProvider();