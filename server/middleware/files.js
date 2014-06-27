'use strict';

// /api/files/* routes

var userAuth = require('../controllers/user-auth.js');
var upload = require('../controllers/upload-files.js');
var db = require('../models/pg-database.js');
var utils = require('../utils.js');
var config = require('../config.js');
var MAX_FILE_SIZE = config.MAX_FILE_SIZE;

var httpStatus = require('http-status');
var validator = require('validator');
var fs = require('fs');

var error = utils.error;
var Visitor = utils.Visitor;


module.exports.session = function (req, res, next) {
  userAuth.getInstanceTokens(req.widgetIds, function (err, tokens) {
    if (!tokens) {
      console.error('getting instance tokens error', err);
      return next(error('widget is not signed in', httpStatus.UNAUTHORIZED));
    }
    upload.getAvailableCapacity(tokens, function (err, capacity) {
      if (err) {
        return next(err);
      }
      db.session.open(req.widgetIds, function (err, sessionId) {

        if (err) {
          return next(error('cannot open session', httpStatus.INTERNAL_SERVER_ERROR));
        }
        var uploadSizeLimit = (!capacity || capacity > MAX_FILE_SIZE) ? MAX_FILE_SIZE : capacity;
        var resJson = {
          sessionId: sessionId,
          uploadSizeLimit: uploadSizeLimit,
          status: httpStatus.OK
        };
        res.status(httpStatus.OK);
        res.json(resJson);
      });
    });
  });
};



module.exports.upload = function (req, res, next) {

  var newFile = req.files.file;
  var sessionId = req.query.sessionId;

  var formatError = null;

  if (!validator.isInt(sessionId)) {
    formatError = error('invalid session format', httpStatus.BAD_REQUEST);
  }

  if (newFile.size >= MAX_FILE_SIZE) {
    formatError = error('file is too large', httpStatus.REQUEST_ENTITY_TOO_LARGE);
  }

  if (formatError) {
    fs.unlink(newFile.path, function (err) {
      if (err) {
        console.error('removing temp file error: ', err);
      }
      return next(formatError);
    });
  } else {

    db.files.checkSessionAndInsert(newFile, sessionId, function (err, fileId) {
      if (!fileId) {
        fs.unlink(newFile.path, function (err) {
          console.error('removing temp file error: ', err);
          return next(error('session expired', httpStatus.BAD_REQUEST));
        });
      }

      var resJson = {
        status: httpStatus.CREATED,
        fileId: fileId
      };
      res.status(httpStatus.CREATED);
      res.json(resJson);
    });
  }
};

/*

JSON format

{
  "name": "kjasdfasfasdf",
  "email": "whasdfasdfs",
  "message": "asdfasfasdfasf"
  "toUpload": [
    "1",
    "2",
    "3"
  ]
}

*/

function parseVisitor(recievedJson) {
  var visitorEmail = recievedJson.visitorEmail;
  var visitorName = recievedJson.visitorName;
  var visitorMessage = recievedJson.visitorMessage;
  var wixSessionToken = recievedJson.wixSessionToken;

  var isRequiredExist = visitorEmail && visitorName && visitorMessage && wixSessionToken;
  // needed because can't trim() undefined
  if (!isRequiredExist) {
    return null;
  }

  visitorEmail = visitorEmail.trim();
  var visitorFirstName = visitorName.first.trim();
  var visitorLastName = visitorName.last.trim();
  visitorMessage = visitorMessage.trim();

  var isValidFormat = validator.isEmail(visitorEmail) &&
                      (visitorFirstName || visitorLastName) &&
                      visitorMessage;

  if (!isValidFormat) {
    return null;
  }

  return new Visitor(visitorFirstName, visitorLastName, visitorEmail, visitorMessage, wixSessionToken);
}

module.exports.commit = function (req, res, next) {

  var recievedJson = req.body;
  var sessionId = req.query.sessionId;

  if (!validator.isInt(sessionId)) {
    return next(error('invalid session format', httpStatus.BAD_REQUEST));
  }

  if (typeof recievedJson !== 'object') {
    return next(error('request body is not JSON', httpStatus.BAD_REQUEST));
  }

  var visitor = parseVisitor(recievedJson);
  var toUploadFileIds = recievedJson.fileIds;
  var isValidFormat = toUploadFileIds instanceof Array && visitor;
  if (!isValidFormat) {
    return next(error('invalid request format', httpStatus.BAD_REQUEST));
  }

  userAuth.getInstanceTokens(req.widgetIds, function (err, tokens) {

    if (!tokens) {
      console.error('getting instance tokens error', err);
      return next(error('widget is not signed in', httpStatus.UNAUTHORIZED));
    }

    db.files.getByIds(sessionId, toUploadFileIds, function (err, files) {
      if (!files) {
        return next(error('cannot find files', httpStatus.BAD_REQUEST));
      }

      if (files[0].sum > MAX_FILE_SIZE) {
        return next(error('total files size is too large', httpStatus.REQUEST_ENTITY_TOO_LARGE));
      }
      upload.getAvailableCapacity(tokens, function (err, capacity) {
        if (err) {
          return next(err);
        }

        if (capacity <= MAX_FILE_SIZE) {
          return next(error('Google Drive is full', httpStatus.REQUEST_ENTITY_TOO_LARGE));
        }
        db.session.close(sessionId, function (err, session) {
          if (!session) {
            return next(error('session has expired', httpStatus.BAD_REQUEST));
          }
          res.status(httpStatus.ACCEPTED);
          res.json({status: httpStatus.ACCEPTED});

          upload.sendFiles(files, visitor, req.widgetIds, sessionId, tokens, function (err) {
            if (err) {
              console.error('something went terribly wrong during upload: ', err);
            }
            return;
          });
        });
      });
    });
  });
};




