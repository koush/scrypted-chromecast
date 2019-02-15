const fs = require('fs');
import { resolve } from 'path';
fs.registerFile(resolve('../node_modules/castv2/lib/cast_channel.proto'), require('raw-loader!../node_modules/castv2/lib/cast_channel.proto'))

const mdns = require('mdns');
import EventEmitter from 'events';
const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
import memoizeOne from 'memoize-one';

function CastDevice(provider, id) {
  this.provider = provider;
  this.id = id;
}

CastDevice.prototype.sendMediaToClient = function (title, mediaUrl, mimeType) {
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
    }
  };

  if (this.player) {
    this.player.load(media, { autoplay: true }, function (err, status) {
      log.i(`media loaded playerState=${status.playerState}`);
    });
    return;
  }

  this.client.launch(DefaultMediaReceiver, (err, player) => {
    this.player = player;
    this.player.on('status', function (status) {
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
    this.player.load(media, { autoplay: true }, function (err, status) {
      if (status) {
        log.i(`media loaded playerState=${status.playerState}`);
      }
      else if (err) {
        log.e(`media load failed ${err}`);
      }
    });
  });
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



const audioFetch = (body) => mediaConverter.convert(body).to('android.net.Uri', 'audio/*');
const memoizeAudioFetch = memoizeOne(audioFetch);

CastDevice.prototype.sendNotificationToHost = function (title, body, media, mimeType) {
  if (!media || this.device.type == 'Speaker') {

    // the mediaConvert variable is provided by Scrypted and can be used to convert
    // MediaObjects into other objects.
    // For example, a MediaObject from a RTSP camera can be converted to an externally
    // accessible Uri png image using mediaConverter.convert.
    memoizeAudioFetch(body)
      .setCallback((e, result) => {
        this.sendMedia(title, result.toString(), 'audio/*');
      });
    return;
  }

  mediaConverter.convert(media, mimeType)
    .to('android.net.Uri', mimeType)
    .setCallback((e, result) => {
      this.sendMedia(title, result.toString(), mimeType);
    });
}

CastDevice.prototype.sendNotification = function (title, body, media, mimeType) {
  if (!this.device) {
    this.provider.search.removeAllListeners(this.id);
    this.provider.search.once(this.id, () => this.sendNotificationToHost(title, body, media, mimeType));
    this.provider.discoverDevices(30000);
    return;
  }

  this.sendNotificationToHost(title, body, media, mimeType);
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

    var interfaces = ['Notifier'];

    var device = {
      id,
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