import { inherits } from 'util';
import { Duplex } from 'stream';

Buffer.alloc = function (len) {
    return new Buffer(len);
}

function Socket() {
    Duplex.call(this, {});
    this.__type = "tcp";
    this._pending = Buffer.alloc(0);
}
inherits(Socket, Duplex);

Socket.prototype.connect = function () {
    var options;
    var callback;

    if (typeof arguments[0] == 'number') {
        options.port = arguments[0];
        if (arguments.length == 2) {
            if (typeof arguments[1] == 'string') {
                options.host = arguments[1];
            }
            else {
                callback = arguments[1];
            }
        }
        else if (arguments.length == 3) {
            options.host = arguments[1];
            callback = arguments[2];
        }
    }
    else {
        options = arguments[0];
        if (arguments.length > 1) {
            callback = arguments[1];
        }
    }

    if (callback) {
        this.once('connect', callback);
    }

    __tcpConnect(options, this.__type,
        function (e, result, writer) {
            // socket
            if (e != null) {
                this.emit('error', new Error(e.getMessage()));
                return;
            }
            this._socket = result;
            this._socket.pause();
            this._writer = writer;
            this.once('_writable', function() {
                this.emit('connect');
            }.bind(this));
        }.bind(this),
        function () {
            // close
            this.emit('close')
        }.bind(this),
        function () {
            // error
            this.emit('error', new Error(e.getMessage()));
        }.bind(this),
        function (data) {
            // data
            data = new Buffer(data);
            if (!this._reading) {
                this._pending = Buffer.concat([this._pending, data]);
                return;
            }

            var sub = data.slice(0, this._reading);
            var remaining = data.slice(this._reading);
            var more = this.push(sub);
            this._pending = remaining;
            if (more) {
                this._socket.resume();
            }
            else {
                this._socket.pause();
            }
        }.bind(this),
        function (socket) {
            // writable
            this.emit('_writable');
        }.bind(this));
}

Socket.prototype._read = function (len) {
    this._reading = len;
    setImmediate(function() {
        this._socket.resume();
    }.bind(this))
}

Socket.prototype._write = function (b, encoding, callback) {
    if (!Buffer.isBuffer(b)) {
        b = new Buffer(b);
    }
    setImmediate(function () {
        this._writer.write(b);
        callback();

        if (this._finalCallback)
            this._finish();
    }.bind(this))
}

// will only ever be called if _final has been called.
Socket.prototype._finish = function () {
    var cb = this._finalCallback;
    delete this._finalCallback;

    this._socket.destroy();
    if (cb)
        cb();
}

Socket.prototype._final = function (cb) {
    this._finalCallback = cb;
    this._finish();
}

Socket.prototype._destroy = function (cb) {
    if (this._socket) {
        this._socket.close();
    }
}
Socket.prototype.setTimeout = function () {
}
Socket.prototype.setNoDelay = function () {
}
Socket.prototype.setKeepAlive = function () {
}

function createConnection() {
    var socket = new Socket();
    socket.connect.apply(socket, arguments);
    return socket;
}
const connect = createConnection;

export {
    Socket,
    createConnection,
    connect,
}
