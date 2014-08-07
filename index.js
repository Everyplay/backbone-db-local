var Backbone = require('backdash');
var BackboneDb = require('backbone-db');
var errors = BackboneDb.errors;

var _ = require('lodash');
var debug = require('debug')('backbone-db-local');
var jsonquery = require('jsonquery');
var util = require('util');

var self = this;

function getStorage(name, delay) {
  delay = delay || 0;
  var storage = self.localStorage;
  var database = {};

  function respond(error, value, cb) {
    if(delay === 0) {
      if(cb) cb(error, value);
    } else {
      setTimeout(function() {
        if(cb) cb(error, value);
      }, delay);
    }
  }
  if (!storage) {
    // "localStorage"
    debug('creating mock storage');
    storage = {
      getItem: function(key, cb) {
        debug('getItem: %s, it is: %o',key, database[key]);
        respond(null, database[key], cb);
        return database[key];
      },
      setItem: function(key, value, cb) {
        debug('setItem: %s to %o, was: %o', key, value, database[key]);
        database[key] = value;
        respond(null, value, cb);
      },
      removeItem: function(key, cb) {
        debug('removeItem: ' + key);
        delete database[key];
        respond(null, true, cb);
      }
    };
  }
  return storage;
}

// in-memory sort, just for mocking db functionality
function sort(property) {
  // sort by multiple properties
  function multisort(properties) {
    return function multiCompare(a, b) {
      var i = 0;
      var result = 0;
      var numberOfProperties = properties.length;
      while(result === 0 && i < numberOfProperties) {
          result = sort(properties[i])(a, b);
          i++;
      }
      return result;
    };
  }

  if (_.isArray(property)) return multisort(property);
  debug('sorting by %s', property || '');
  var sortOrder = 1;
  if (property[0] === '-') {
    sortOrder = -1;
    property = property.substr(1);
  }
  function compare(a, b) {
    var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
    return result * sortOrder;
  }
  return compare;
}

function filterModels(models, filterOptions, callback) {
  if (!filterOptions.where) return callback(null, models);
  debug('filtering results: %o', filterOptions);
  var filteredModels = [];

  filterOptions.where = _.mapValues(filterOptions.where, function(val) {
    if (typeof val === 'object' && val.toString && val.toString().length === 24) {
      return val.toString();
    } else if (_.isDate(val)) {
      return val.toString();
    } else if (_.isObject(val)) {
      _.each(val, function(v, k) {
        if (_.isDate(v)) val[k] = v.toString();
      });
      return val;
    } else {
      return val;
    }
  });
  var jq = jsonquery(filterOptions.where);

  jq.on('data', function(model) {
    filteredModels.push(model);
  });

  jq.on('end', function() {
    callback(null, filteredModels);
  });

  _.map(models, jq.write);
  jq.end();
}

// mock sort, offset, after_id, before_id, limit & filtering
function queryModels(models, options, callback) {
  var i;
  var offset = options.offset ? options.offset : 0;
  var limit = options.limit ? options.limit : models.length;
  filterModels(models, options, function(err, models) {
    if (options.sort) models.sort(sort(options.sort));
    if (options.after_id) {
      for (i = 0; i < models.length; i++) {
        if (models[i].id === options.after_id) {
          offset = i + 1;
          break;
        }
      }
    }
    if (options.before_id) {
      for (i = 0; i < models.length; i++) {
        if (models[i].id === options.before_id) {
          offset = i - limit;
          if (offset < 0) offset = 0;
          break;
        }
      }
    }
    models = models.splice(offset, limit);
    callback(err, models);
  });

}

var getKey = function(model) {
  if (!model.url) return getKey(model);
  return _.result(model, 'url');
};

var LocalDb = Backbone.Db = function LocalDb(name, options) {
  var self = this;
  options = options || {};
  if (!(self instanceof LocalDb)) return new LocalDb(name);
  this.name = name;
  this.options = options;
  this.storage = getStorage(this.name, options.delay);
  this.records = [];
  // bypass event loop
  this.records = this.store().getItem(this.name, function() {});
  this.records = (this.records && this.records.split(',')) || [];
};

_.extend(LocalDb.prototype, Backbone.Events, {
  save: function(cb) {
    this.store().setItem(this.name, JSON.stringify(this.records), function() {
      cb(null);
    });
  },

  create: function(model, options, cb) {
    debug('CREATE: %o', model.toJSON());
    var self = this;

    function store(model) {
      self.store().setItem(getKey(model), JSON.stringify(model), function(err, res) {
        self.records.push(getKey(model));
        self.save(function(err) {
          return cb(err, model.toJSON(options), res);
        });
      });
    }

    if (model.isNew()) {
      this.createId(model, options, function(err, id) {
        store(model);
      });
    } else {
      store(model);
    }
  },

  find: function(model, options, cb) {
    debug('FIND model: %o, options %o',model.toJSON(), options);
    this.store().getItem(getKey(model), function(err, data) {
      data = data && JSON.parse(data);
      var errorMsg = util.format('%s (%s) not found (read)', model.type, model.id);
      var error = err || data ? null : new errors.NotFoundError(errorMsg);
      return cb(error, data);
    });
  },

  findAll: function(model, options, cb) {
    debug('FINDALL: %o', options);
    var self = this;
    var models = [];
    var done;

    if (!model.model) {
      debug('fetch model');
      var indexedKeys = _.pluck(model.indexes, 'property');
      var objectKeys = Object.keys(model.attributes);
      var searchAttrs = {};
      var allIndexed = _.each(objectKeys, function(attr) {
        if (indexedKeys.indexOf(attr) > -1) {
          searchAttrs[attr] = model.get(attr);
        }
      });
      if (!Object.keys(searchAttrs).length) {
        var err = new Error('Cannot fetch model with given attributes');
        return cb(err);
      }
      options.where = searchAttrs;
    }

    if (this.records.length > 0) {
      done = _.after(this.records.length, function() {
        queryModels(models, options, function(err, results) {
          if (!model.model) {
            if (!results || results.length === 0) {
              var errorMsg = util.format('%s (%s) not found (read)', model.type, model.id);
              err = err || new errors.NotFoundError(errorMsg);
            }
            return cb(err, results && results.length && results[0]);
          }
          cb(err, results);
        });
      });
    } else {
      return cb(null, []);
    }

    this.records.forEach(function(id) {
      self.store().getItem(id, function(err, data) {
        data = data && JSON.parse(data);
        models.push(data);
        done();
      });
    });
  },

  destroy: function(model, options, cb) {
    debug('DESTROY: %o', model.toJSON(options));
    var self = this;
    if (model.isNew()) {
      return false;
    }
    var modelId = getKey(model);
    this.store().removeItem(modelId, function() {
      var found = false;
      self.records = _.reject(self.records, function(id) {
        var itemFound = id === modelId;
        if (!found) found = itemFound;
        return itemFound;
      });
      if (!found) {
        var errorMsg = util.format('%s (%s) not found (destroy)', model.type, model.id);
        return cb(new errors.NotFoundError(errorMsg));
      }
      self.save(function(err) {
        cb(err, model);
      });
    });
  },

  update: function(model, options, cb) {
    var self = this;
    debug('UPDATE: ' + JSON.stringify(model));
    if (model.isNew()) {
      debug('new');
      return this.create(model, options, cb);
    }
    if (options.inc) {
      return this.inc(model, options, cb);
    }
    var id = getKey(model);
    var data = this.store().getItem(id);

    //this.store().getItem(id, function(err, data) {
    data = data && JSON.parse(data);
    var modelData = model.toJSON(options);
      // Support for non plain object JSON types.
    if (_.isPlainObject(data) && _.isPlainObject(modelData)) {
      _.merge(data, modelData);
    } else if (_.isArray(data)) {
      data = _.uniq(data.concat(modelData));
    } else {
      data = modelData;
    }

    self.store().setItem(id, JSON.stringify(data));
    if (self.records.indexOf(id) === -1) {
      self.records.push(id);
    }
    cb(null, model.toJSON(options), data);
  },

  _createDefaultId: (function(id) {
    return function(callback) {
      debug('_createDefaultId');
      callback(null, id++);
    };
  })(1),

  createId: function(model, options, callback) {
    debug('createId');
    var createIdFn = model.createId ? _.bind(model.createId, model) : this._createDefaultId;
    createIdFn(function(err, id) {
      model.set(model.idAttribute, id);
      callback(err);
    });
  },

  inc: function(model, options, cb) {
    debug('INC:', options.inc);
    var self = this;
    var attribute = options.inc.attribute;
    var amount = options.inc.amount;
    var key = getKey(model);
    var data = this.store().getItem(key, function() {});
    if(data) {

      data = JSON.parse(data);
      var value = data.hasOwnProperty(attribute) ? data[attribute] : 0;
      value += amount;
      data[attribute] = value;
      self.store().setItem(key, JSON.stringify(data), function(err, res) {
        cb(err, data, res);
      });
    } else {
      if (options.ignoreFailures) {
        return cb(null, model);
      }
      var errorMsg = util.format('%s (%s), cannot INC', model.type, model.id);
      return cb(new errors.NotFoundError(errorMsg));
    }
  },

  // expose "raw" storage backend.
  store: function() {
    return this.storage;
  }
});

LocalDb.prototype.sync = BackboneDb.prototype.sync;
LocalDb.sync = LocalDb.prototype.sync;

module.exports = LocalDb;
