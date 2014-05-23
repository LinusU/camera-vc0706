var tessel = require('tessel');
var events = require('events');
var util = require('util');
var vclib = require('vclib');

var DEBUG = false;

function Camera (hardware, next){
  // Set the port
  this.hardware = hardware;
  // Set a new library for sending/receiving data
  this.vclib = new vclib();
  // Start up UART
  this.uart = hardware.UART({baudrate : 115200});
  // Turn the camera on!
  hardware.digital[3].output().high();

  // Attempt to read the version of firmware
  this.getVersion(function(err, version) {
    // If there was a problem
    if (err || !version) {
      // Report an error
      setImmediate(function() {
        this.emit('error', new Error("Unable to receive responses from module."));
      }.bind(this));
    }
    // If there was no problem
    else {
      // Report that we are open for business
      setImmediate(function() {
        this.emit('ready');
      }.bind(this));
    }

    // Call the callback
    if (next) next(err, this);
    return this;

  }.bind(this));
}

util.inherits(Camera, events.EventEmitter);

// Get the version of firmware on the camera. Typically only used for debugging.
Camera.prototype._getVersion = function (next){
  this._sendCommand("version", next);
};

// Set the resolution of the images captured. Automatically resets the camera and returns after completion.
Camera.prototype.setResolution = function(resolution, next) {
  this._sendCommand("resolution", {"size":resolution}, function(err) {
    if (err) {

      if (next) next(err);

      return;
    }
    else {
      this._reset(function(err) {

        if (next) next(err);

        setImmediate(function() {
          this.emit('resolution', resolution);
        }.bind(this));

      }.bind(this));
    }
  }.bind(this));
};

// Set the compression of the images captured. Automatically resets the camera and returns after completion.
Camera.prototype.setCompression = function(compression, next) {
  this._sendCommand("compression", {"ratio":compression}, function(err) {
    if (err) {
      if (next) next(err);
      return;
    }
    else {
      this._reset(function(err) {

        if (next) next(err);

        setImmediate(function() {
          this.emit('compression', compression);
        }.bind(this));

        return;
      }.bind(this));
    }
  }.bind(this));
};

// Primary method for capturing an image. Actually transfers the image over SPI Slave as opposed to UART.
Camera.prototype.takePicture = function(next) {
  // Get data about how many bytes to read
  this._getImageMetaData(function foundMetaData(err, imageLength) {
    if (err) {
      if (next) next(err);
      return;
    }
    else {
      // Capture the actual data
      this._captureImageData(imageLength, function imageCaptured(err, image) {
        // Wait for the camera to be ready to continue
        if (err) {
          if (next) next(err);

          return;
        }
        else {
          this._resolveCapture(image, next);
        }
      }.bind(this));
    }
  }.bind(this));
};

Camera.prototype._getImageMetaData = function(next) {
  // Stop the frame buffer (capture the image...)
  this._stopFrameBuffer(function imageFrameStopped(err) {

    if (err) {
      if (next) next(err);

      return;
    }
    else {
      // Get the size of the image to capture
      this._getFrameBufferLength(function imageLengthRead(err, imgSize) {
        // If there was a problem, report it
        if (err) {
          if (next) next(err);

          return;
        }
        // If not
        else {
          if (next) next(null, imgSize);

          return;
        }
      }.bind(this));
    }
  }.bind(this));
};

// Close camera connection
Camera.prototype.close = function () {
  this.uart.disable();
};

Camera.prototype._captureImageData = function(imgSize, next) {

   // Intialize SPI
  var spi = this.hardware.SPI({role:'slave'});

  // Send the command to read the number of bytes
  this._readFrameBuffer(imgSize, function imageReadCommandSent(err) {
    // If there was a problem report it
    if (err) {
      if (next) next(err);

      return;
    }
    // If not
    else {
      // Begin the transfer
      spi.receive(imgSize, function imageDataRead(err, image){

        // If there was a problem, report it
        if (err) {
          if (next) next(err);

          return;
        }
        // If not
        else {
          // Close SPI
          spi.close();

          if (next) next(null, image);

          return;
        }
      }.bind(this));
    }
  }.bind(this));
};

Camera.prototype._resolveCapture = function(image, next) {
  // Wait for the camera to tell us it's finished
  this._waitForImageReadACK(function ACKed(err) {
    // Report any errors
    if (err) {
      if (next) next(err);

      return;
    }
    else {
      // Resume frame capturing again
      this._resumeFrameBuffer(function frameResumed(err) {
        // Report any errors
        if (err) {
          if (next) next(err);

          return;
        }
        else {
          // Call the callback
          if (next) next(null, image);
            // Emit the picture

          setImmediate(function() {
            this.emit('picture', image);
          }.bind(this));
        }
      }.bind(this));
    }
  }.bind(this));
};

Camera.prototype._getFrameBufferLength = function(next) {
  this._sendCommand("bufferLength", next);
};

Camera.prototype._readFrameBuffer = function(length, next) {
  this._sendCommand("readFrameSPI", {"length":length}, next);
};

Camera.prototype._stopFrameBuffer = function(next) {
  this._sendCommand("frameControl", {command:'stop'}, next);
};

Camera.prototype._resumeFrameBuffer = function(next) {
  this._sendCommand("frameControl", {command:'resume'}, next);
};

Camera.prototype._reset = function(next) {
  // Tell the module to reset
  this._sendCommand('reset', function(err) {
    // If there was a problem
    if (err) {
      // Report it immediately
      if (next) next(err);

      return;
    }
    // If there was no problem
    else {
      // Wait for the camera to reset
      setTimeout(next, 300);
    }
  });
};

Camera.prototype._waitForImageReadACK = function(next) {
  var self = this;
  self.vclib.getCommandPacket('readFrameSPI', function foundCommand(err, command) {
    self.uart.on('data', function dataACKParsing(data) {
      self.vclib.parseIncoming(command, data, function vclibDataParsed(err, packet) {
        if (err || packet) {

          self.uart.removeListener('data', dataACKParsing);

          if (next) next(err);
          return;
        }
      });
    });
  });
};

Camera.prototype._sendCommand = function(apiCommand, args, next) {
  // If Args weren't passed in, correct the callback
  if (typeof args === 'function') {
    next = args;
    args = {};
  }
  if (!args) {
    args = {};
  }

  var self = this;
  var timeout;

  // Get the command packet for the request api call
  self.vclib.getCommandPacket(apiCommand, args, function(err, command) {

    if (err) {
      if (next) next(err);
      return;
    }

    function UARTDataParser(data) {
      // Try to parse the response (might take several calls)
      self.vclib.parseIncoming(command, data, function(err, packet) {

        // Clear no-data timeout
        clearTimeout(timeout);

        // If it was parsed
        if (err || packet) {
          // Grab the response if available
          var response = packet ? packet.response : null;
          // Remove this listener
          self.uart.removeListener('data', UARTDataParser);
          // Call the callback. Transaction complete
          if (next) next(err, response);
          return;
        }
      });
    }

    // Set up a temporary listener... listening for response
    self.uart.on('data', UARTDataParser);

    // Send the command data
    self.uart.write(command.buffer);

    timeout = setTimeout(function noResponse() {
      // Remove the listener
      self.uart.removeListener('data', UARTDataParser);

      // Throw an error
      if (next) next(new Error("No UART Response..."));

      return;

    }, 2000);
  });
};

function use(hardware, next) {
  var camera = new Camera(hardware, next);
  return camera;
}

module.exports.Camera = Camera;
module.exports.use = use;
