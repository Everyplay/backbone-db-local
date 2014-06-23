/**
 * Allow this test suite to be used on custom implementations of db, model and collection.
 */
var _ = require('lodash');
var Backbone = require('backbone');
var modelTests = require('backbone-db/test/test.model');
var collectionTests = require('backbone-db/test/test.collection');
var Db = require('..');

describe('backbone-db', function () {

  before(function () {
    this.db = new Db('mymodels');
    this.Model = Backbone.Model.extend({
      url: function () {
        if (this.isNew()) {
          return 'mymodels';
        }
        return 'mymodels:' + this.get(this.idAttribute);
      },
      db: this.db,
      sync: this.db.sync
    });
    this.Collection = Backbone.Collection.extend({
      url: function () {
        return 'mymodels';
      },
      model: this.Model,
      db: this.db,
      sync: this.db.sync
    });
  });

  describe('Model', function () {
    after(function () {
      this.db = new Db('mymodels');
      this.Collection.prototype.db = this.db;
      this.Model.prototype.db = this.db;
    });
    modelTests();
  });

  describe('Collection', function () {
    after(function () {
      this.db = new Db('mymodels');
      this.Collection.prototype.db = this.db;
      this.Model.prototype.db = this.db;
    });
    collectionTests();
  });
});