'use strict';

var path = require('path');
var request = require('request');
var xml2js = require('xml2js');
var async = require('async');

function Dependency(opts) {
  if (typeof opts !== 'undefined') {
    this.repository = opts.repository;
  }
}

Dependency.prototype.toString = function() {
  return this.groupId + ':' + this.artifactId + ':' + this.version;
};

Dependency.prototype.getGroupPath = function() {
  return this.groupId.replace(/\./g, '/');
};

Dependency.prototype.getArtifactPath = function() {
  return path.join(this.getGroupPath(), this.artifactId);
};

Dependency.prototype.getVersionPath = function() {
  if (!this.version) {
    throw new Error('version not found for ' + this.toString());
  }
  return path.join(this.getArtifactPath(), this.version);
};

Dependency.prototype.getPomPath = function(callback) {
  var that = this;
  this.getPomFileName(function (err, filename) {
    if (err) return callback(err);
    callback(null, path.join(that.getVersionPath(), filename));
  });
};

Dependency.prototype.getJarPath = function(callback) {
  var that = this;
  this.getJarFileName(function (err, filename) {
    if (err) return callback(err);
    callback(null, path.join(that.getVersionPath(), filename));
  });
};

Dependency.prototype.getJarFileName = function(callback) {
  if (this.version.indexOf('SNAPSHOT') < 0) {
    callback(null, this.artifactId + '-' + this.version + ( this.classifier ? '-' + this.classifier : '' ) + '.jar');
  } else {
    //Get snapshot name
    var that = this;
    this.getSnapshot(function (err, snapshot) {
      if (err) return callback(err);
      if (!snapshot) {
        return callback(null, that.artifactId + '-' + that.version + ( that.classifier ? '-' + that.classifier : '' ) + '.jar');
      }
      callback(null, that.artifactId + '-' + that.version.substring(0, that.version.indexOf('SNAPSHOT')) + snapshot.timestamp + '-' + snapshot.buildNumber + '.jar');
    })
  }
};

Dependency.prototype.getPomFileName = function(callback) {
  if (this.version.indexOf('SNAPSHOT') < 0) {
    callback(null, this.artifactId + '-' + this.version + '.pom');
  } else {
    //Get snapshot name
    var that = this;
    this.getSnapshot(function (err, snapshot) {
      if (err) return callback(err);
      if (!snapshot) {
        return callback(null, that.artifactId + '-' + that.version + '.pom');
      }
      callback(null, that.artifactId + '-' + that.version.substring(0, that.version.indexOf('SNAPSHOT')) + snapshot.timestamp + '-' + snapshot.buildNumber + '.pom');
    })
  }
};

Dependency.prototype.getSnapshot = function (callback) {
  var that = this;
  var metas = [];
  this.repositories.forEach(function (repository) {
    metas.push(path.join(repository.url, that.getVersionPath(), 'maven-metadata.xml').replace(':/', '://'));
  });
  async.reduce(metas, null, function (memo, item, cb) {
    if (memo != null) cb(null, memo);
    request.get(item, function (err, response, data) {
      if (err) return cb(null);
      if (response.statusCode !== 200) return cb(null);
      cb(null, data);
    });
  }, function (err, result) {
    if (!result) return callback(null, null);
    xml2js.parseString(result, function (err, xml) {
      if (err) {
        return callback(err);
      }
      callback(null, {
        timestamp: xml.metadata.versioning[0].snapshot[0].timestamp[0],
        buildNumber: xml.metadata.versioning[0].snapshot[0].buildNumber[0]
      });
    });
  });
};

Dependency.prototype.getPackaging = function() {
  if (!this.pomXml) {
    throw new Error('Could not find pomXml for dependency: ' + this.toString());
  }
  if (this.pomXml.project && this.pomXml.project.packaging) {
    return this.pomXml.project.packaging[0];
  } else {
    return 'jar';
  }
};

Dependency.prototype.getParent = function() {
  if (!this.pomXml || !this.pomXml.project) {
    throw new Error("Invalid dependency state. Missing pomXml. " + this);
  }
  if (this.pomXml.project.parent) {
    var p = this.pomXml.project.parent[0];
    return Dependency.createFromXmlObject(p, this.reason, this.repositories);
  }
  return null;
};

Dependency.prototype.getDependencies = function() {
  if (
    this.pomXml.project
    && this.pomXml.project.dependencies
    && this.pomXml.project.dependencies[0]
    && this.pomXml.project.dependencies[0].dependency) {
    var reason = this.reason;
    if (reason) {
      reason += '/';
    }
    reason += this.toString();
    var dependencies = this.pomXml.project.dependencies[0].dependency;
    var that = this;
    return dependencies.map(function(d) {
      return Dependency.createFromXmlObject(d, reason, that.repositories);
    });
  }
  return [];
};

Dependency.prototype.getDependencyManagementDependencies = function() {
  if (
    this.pomXml.project
    && this.pomXml.project.dependencyManagement
    && this.pomXml.project.dependencyManagement[0]
    && this.pomXml.project.dependencyManagement[0].dependencies
    && this.pomXml.project.dependencyManagement[0].dependencies[0]
    && this.pomXml.project.dependencyManagement[0].dependencies[0].dependency) {
    var reason = this.reason;
    if (reason) {
      reason += '/';
    }
    reason += this.toString();

    var dependencies = this.pomXml.project.dependencyManagement[0].dependencies[0].dependency;
    var that = this;
    return dependencies.map(function(d) {
      return Dependency.createFromXmlObject(d, reason, that.repositories);
    });
  }
  return [];
};

Dependency.prototype.markCompleted = function() {
  this.complete = true;
};

// this is a hack to wait for in flight dependencies to complete
Dependency.prototype.waitUntilComplete = function(callback) {
  callback = callback || function() {};
  var me = this;
  var count = 0;
  var wait = setInterval(function() {
    if (me.complete) {
      clearInterval(wait);
      if (!callback) {
        return false;
      }
      var cb = callback;
      callback = null;
      return cb();
    }

    count++;
    if (count > 100) {
      console.log('waiting for ' + me.toString() + ' [state: ' + me.state + ']');
      count = 0;
    }

    return false;
  }, 10);
};

Dependency.createFromObject = function(obj, reason) {
  var result = new Dependency();
  result.reason = reason;
  Object.keys(obj).forEach(function(k) {
    result[k] = obj[k];
  });
  return result;
};

Dependency.createFromXmlObject = function(xml, reason, repositories) {
  return Dependency.createFromObject({
    groupId: xml.groupId[0],
    artifactId: xml.artifactId[0],
    classifier: xml.classifier && xml.classifier[0],
    version: xml.version ? xml.version[0] : null,
    scope: xml.scope ? xml.scope[0] : 'compile',
    optional: xml.optional ? (xml.optional[0] == 'true') : false,
    repositories: repositories
  }, reason);
};

module.exports = Dependency;
