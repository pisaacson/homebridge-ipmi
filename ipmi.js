'use strict';
var path = require("path");
var sprintf = require("sprintf-js").sprintf, inherits = require("util").inherits;
var events = require('events'), util = require('util'), fs = require('fs');
var Accessory, Characteristic, Service, UUIDGen;
var moment = require('moment');
var correctingInterval = require('correcting-interval');
const version = require('./package.json').version;
const Format = require('util').format;

const IPMI = require('node-ipmi');
const exec = require('child_process').exec; // TODO: move to node-ipmi

//let Service, Characteristic;

module.exports = function(homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  Accessory = homebridge.platformAccessory;
  UUIDGen = homebridge.hap.uuid;
  var FakeGatoHistoryService = require('fakegato-history')(homebridge);

	/* Try to map Elgato custom vars */
	IPMIPlugin.CurrentVoltageReading = function () {
		Characteristic.call(this, 'Volt', 'E863F10A-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.FLOAT,
			unit: "Volts",
			maxValue: 1000,
			minValue: 0,
			minStep: 0.1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};
  IPMIPlugin.CurrentVoltageReading = 'E863F10A-079E-48FF-8F27-9C2605A29F52';
  inherits(IPMIPlugin.CurrentVoltageReading, Characteristic);

	IPMIPlugin.CurrentPowerConsumption = function () {
		Characteristic.call(this, 'Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.UINT16,
			unit: "Watts",
			maxValue: 1000,
			minValue: 0,
			minStep: 1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};
	IPMIPlugin.CurrentPowerConsumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
	inherits(IPMIPlugin.CurrentPowerConsumption, Characteristic);

	IPMIPlugin.TotalConsumption = function () {
		Characteristic.call(this, 'Energy', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.FLOAT,
			unit: "kWh",
			maxValue: 100000000000,
			minValue: 0,
			minStep: 0.001,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};
	IPMIPlugin.TotalConsumption.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
	inherits(IPMIPlugin.TotalConsumption, Characteristic);

	IPMIPlugin.ResetTotal = function () {
		Characteristic.call(this, 'Reset', 'E863F112-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.UINT32,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY, Characteristic.Perms.WRITE]
		});
		this.value = this.getDefaultValue();
	};
	IPMIPlugin.ResetTotal.UUID = 'E863F112-079E-48FF-8F27-9C2605A29F52';
	inherits(IPMIPlugin.ResetTotal, Characteristic);

	IPMIPlugin.PowerMeterService = function (displayName, subtype) {
		Service.call(this, displayName, '00000001-0000-1777-8000-775D67EC4377', subtype);
		this.addCharacteristic(IPMIPlugin.CurrentPowerConsumption);
		this.addCharacteristic(IPMIPlugin.TotalConsumption);
		this.addCharacteristic(IPMIPlugin.ResetTotal);
	};
	inherits(IPMIPlugin.PowerMeterService, Service);

	IPMIPlugin.FakeGatoHistoryService = FakeGatoHistoryService;
	inherits(IPMIPlugin.FakeGatoHistoryService, Service);


  homebridge.registerAccessory('homebridge-ipmi', 'IPMI', IPMIPlugin);
};

class IPMIPlugin
{
  constructor(log, config) {
    this.log = log;
    this.name = 'IPMI';

    // Server configuration - if omitted, use null to not specify (different from undefined/missing = prompt)
    this.hostname = config.hostname || null;
    this.username = config.username || null;
    this.password = config.password || null;

    // Sensors of interest, mapping IPMI name to Homebridge name
    this.temperatureSensors = config.temperatureSensors ||  {
                        'System Temp': 'System',
                        'Peripheral Temp': 'Peripheral'
                };
    this.fans = config.fans ||  {
                        'FAN 1': 'Fan 1',
                        'FAN 2': 'Fan 2',
                        'FAN 3': 'Fan 3',
                        'FAN 4': 'Fan 4',
                        'FAN A': 'Fan A'
                };
    this.power = config.power
    this.identify = config.identify !== undefined ? config.identify : "Blink";

    this.server = new IPMI(this.hostname, this.username, this.password);
    this.cache = {};
    this._refreshData();

    this.sensors = [];

    this.identifyOn = false; // TODO: get from ipmitool
    if (this.identify !== null) {
      const switchSensor = new Service.Switch(this.identify);
      switchSensor
        .getCharacteristic(Characteristic.On)
        .on('get', this.getIdentify.bind(this))
        .on('set', this.setIdentify.bind(this));
      this.sensors.push(switchSensor);
    }

    Object.keys(this.temperatureSensors).forEach((ipmiName) => {
      const name = this.temperatureSensors[ipmiName];
      const subtype = ipmiName; // subtype must be unique per uuid
      const tempSensor = new Service.TemperatureSensor(name, subtype);
      tempSensor
        .getCharacteristic(Characteristic.CurrentTemperature)
        .on('get', this.getTemperature.bind(this, ipmiName));
      this.sensors.push(tempSensor);
    });

    Object.keys(this.fans).forEach((ipmiName) => {
      const name = this.fans[ipmiName];
      const subtype = ipmiName;
      const fan = new Service.Fan(name, subtype);
      fan
        .getCharacteristic(Characteristic.On)
        .on('get', this.getFanOn.bind(this, ipmiName));
      fan
        .getCharacteristic(Characteristic.RotationSpeed)
        .on('get', this.getFanRotationSpeed.bind(this, ipmiName));
      this.sensors.push(fan);
    });
  }

  getIdentify(cb) {
    cb(null, this.identifyOn);
  }

  setIdentify(on, cb) {
    let cmd;
    if (on) {
      // forces on until turned off (otherwise, turns off after an interval)
      cmd = 'ipmitool chassis identify force';
    } else {
      cmd = 'ipmitool chassis identify 0';
    }

    exec(cmd, () => cb(null)); // TODO: check error
  }

  _refreshData() {
    // TODO: throttle refreshes? currently schedules an update for each get (even if redundant)
    const refreshdata = true; // fix/workaround https://github.com/egeback/node-ipmi/pull/1 Fix callback reuse when not refreshing
    this.server.getSensors((err, sensors) => {
      if (err) throw err;

       for (let i = 0; i < sensors.length; ++i) {
         const sensor = sensors[i];

         this.cache[sensor.data.name] = sensor.data.value;
       }
       //console.log('updated cache=',this.cache);
    }, refreshdata);
  }

  getTemperature(ipmiName, cb) {
    // degrees C
    cb(null, this.cache[ipmiName]);
    this._refreshData();
  }

  getFanOn(ipmiName, cb) {
    const on = this.cache[ipmiName] > 0;
    cb(null, on);
    this._refreshData();
  }

  getFanRotationSpeed(ipmiName, cb) {
    // RPM
    cb(null, this.cache[ipmiName]);
    this._refreshData();
  }

  getServices() {
    return this.sensors;
    this._refreshData();
  }
}
