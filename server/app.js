'use strict';

var userAuth = require('./modules/user-auth.js');
var googleDrive = require('./modules/google-drive.js');
var db = require('./modules/pg-database.js');
var express = require('express');
var bodyParser = require('body-parser');
var multer  = require('multer');
var validator = require('validator');
var pg = require('pg');
var wix = require('wix');
var httpStatus = require('http-status');
var connectionString = process.env.DATABASE_URL || require('./connect-keys/pg-connect.json').connectPg;
var app = express();

wix.secret(require('./connect-keys/wix-key.json').secret);
app.use(bodyParser());
app.use(express.static(__dirname));
app.use(multer({
  dest: './tmp/'
}));


// parse instance and sets parsed insatnceId
function WixWidget(instance, compId) {
  this.instanceId = wix.parse(instance).instanceId;
  this.compId = compId;
}


app.get('/oauth2callback', function (req, res) {
  userAuth.exchangeCodeForTokens(req.query.code, function (err, tokens) {
    console.log('tokens from google: ', tokens);
    console.log('oauth2callback state: ', req.query.state);

    var wixIds = req.query.state.split('+');
    var currInstance = new WixWidget(wixIds[0], wixIds[1]);

    var provider = 'google';
    pg.connect(connectionString, function (err, client, done) {
      if (err) { console.error('db connection error: ', err); }

      db.token.insert(client, currInstance, tokens, provider, function (err) {
        userAuth.getWidgetEmail(tokens, function (err, widgetEmail) {
          var widgetSettings = {
            userEmail: widgetEmail || '',
            provider: provider,
            settings: null  // won't reset anything because there is a COALESCE condition in query
          };
          db.widget.getSettings(client, currInstance, function (err, widgetSettingsFromDb) {
            if (widgetSettingsFromDb !== null) {
              var isEmailSet = widgetSettingsFromDb.user_email !== '';
              // do not update if email already set
              if (isEmailSet) { widgetSettings.userEmail = null; }
              db.widget.updateSettings(client, currInstance, widgetSettings, function (err) {
                done();
                pg.end();
                res.redirect('/');
              });
            } else {
              widgetSettings.settings = '{}';
              db.widget.insertSettings(client, currInstance, widgetSettings, function (err) {
                done();
                pg.end();
                res.redirect('/');
              });
            }
          });
        });
      });
    });
  });
});

app.get('/login/auth/google/:compId', function (req, res) {
  // var instance = req.header('X-Wix-Instance');
  var currInstance = {
    instanceId: 'whatever',
    compId: 'however'
  }; //new WixWidget(instance, req.params.compId);

  pg.connect(connectionString, function (err, client, done) {
    db.token.get(client, currInstance, 'google', function (err, tokensFromDb) {
      if (tokensFromDb !== null) {
        userAuth.getGoogleAuthUrl(currInstance, function (url) {
          done();
          pg.end();
          res.redirect(url);
        });
      } else {
        console.error('You are still signed in with Google.');
        done();
        pg.end();
        res.redirect('/logout/auth/google');
      }
    });
  });
});

app.get('/logout/auth/google/:compId', function (req, res) {
  // var instance = req.header('X-Wix-Instance');
  var currInstance = {
    instanceId: 'whatever',
    compId: 'however'
  }; //new WixWidget(instance, req.params.compId);

  pg.connect(connectionString, function (err, client, done) {
    if (err) { console.error('db connection error: ', err); }

    db.token.remove(client, currInstance, 'google', function (err, tokensFromDb) {

      if (err) {
        done();
        pg.end();
        console.error('Your are not signed with Google');
        return res.redirect('/');
      }

      var widgetSettings = {
        userEmail: null,
        provider: '',
        settings: null  // won't reset anything because there is a COALESCE condition in query
      };

      db.widget.updateSettings(client, currInstance, widgetSettings, function (err, updatedWidgetSettings) {
        var oauth2Client = userAuth.createOauth2Client();
        oauth2Client.revokeToken(tokensFromDb.refresh_token, function (err, result) {
          if (err) { console.error('token revoking error', err); }

          console.log('revoking token');
          done();
          pg.end();
          res.redirect('/');

        });
      });
    });
  });
});


app.get('/login', function (req, res) {
  res.sendfile('./login.html');
});


function setError(res, message, statusCode) {
  var resJson = {
    code: statusCode,
    error: message
  };
  res.status(statusCode);
  return resJson;
}



app.post('/api/files/upload/:compId', function (req, res) {
  // var instance = req.header('X-Wix-Instance');
  var currInstance = {
    instanceId: 'whatever',
    compId: 'however'
  }; //new WixWidget(instance, req.params.compId)

  var MAX_FILE_SIZE = 1073741824;

  console.log('uploaded file: ', req);
  var newFile = req.files.sendFile;
  var sessionId = req.query.sessionId;

  if (!validator.isNumeric(sessionId)) {
    return res.json(setError(res, 'invalid session format', httpStatus.BAD_REQUEST));
  }

  if (newFile.size >= MAX_FILE_SIZE) {
    return res.json(setError(res, 'file is too large', httpStatus.REQUEST_ENTITY_TOO_LARGE));
  }

  pg.connect(connectionString, function (err, client, done) {
    if (err) { console.error('db connection error: ', err); }
    db.session.update(client, sessionId, currInstance, function (err) {

      if (err) {
        // expired session or non-existing session or mistyped sessionId
        return res.json(setError(res, 'session is not found', httpStatus.UNAUTHORIZED));
      }

      db.files.insert(client, sessionId, newFile, function (err, fileId) {
        if (fileId !== null) {
          var resJson = {
            code: httpStatus.OK,
            fileId: fileId
          };
          res.status(httpStatus.OK);
          res.json(resJson);
        }
      });
    });
  });
});


app.post('/api/files/send/:compId', function (req, res) {

  var MAX_FILE_SIZE = 1073741824;
  // var instance = req.header('X-Wix-Instance');
  var currInstance = {
    instanceId: 'whatever',
    compId: 'however'
  }; //new WixWidget(instance, req.params.compId)

  // parse the request

  var recievedJson = req.body;
  var sessionId = req.query.sessionId;

  if (!validator.isNumeric(sessionId)) {
    return res.json(setError(res, 'invalid session format', httpStatus.BAD_REQUEST));
  }

  if (!validator.isJSON(recievedJson)) {
    return res.json(setError(res, 'request body is not JSON', httpStatus.BAD_REQUEST));
  }

  var visitorEmail = recievedJson.email.trim();
  var visitorName = recievedJson.name.trim();
  var toUploadFileIds = recievedJson.toUpload;
  var visitorMessage = recievedJson.message.trim();

  var isValidFormat = validator.isEmail(visitorEmail) &&
                      toUploadFileIds.isArray() &&
                      !validator.isNull(visitorName) &&
                      !validator.isNull(visitorMessage);

  if (!isValidFormat) {
    return res.json(setError(res, 'invalid request format', httpStatus.BAD_REQUEST));
  }

  pg.connect(connectionString, function (err, client, done) {
    if (err) { console.error('db connection error: ', err); }
    userAuth.getInstanceTokens(client, currInstance, function (err, tokens) {

      if (err) {
        done();
        pg.end();
        console.error('getting instance tokens error', err);
        return res.json(setError(res, 'widget is not signed in', httpStatus.BAD_REQUEST));
      }
      db.files.getByIds(client, sessionId, toUploadFileIds, function (err, files) {
        if (err) {
          done();
          pg.end();
          console.error('cannot find files', err);
          return res.json(setError(res, 'cannot find files', httpStatus.BAD_REQUEST));
        }

        if (files[0].total_size > MAX_FILE_SIZE) {
          done();
          pg.end();
          console.error('cannot find files', err);
          return res.json(setError(res, 'total files size is too large', httpStatus.REQUEST_ENTITY_TOO_LARGE));
        }

        console.log('files to be zipped: ', files);
        // TODO: abstract file uploading to serices: get provider
        // TODO: zip files into a single archive
        // googleDrive.insertFile(newFile, tokens.access_token, function (err, result) {
        //   if (err) { console.error('uploading to google error', err); }
        //   console.log('inserted file: ', result);
          done();
          pg.end();
          req.status(httpStatus.ACCEPTED);
          res.json({code: httpStatus.ACCEPTED});
        // });
      });
    });
  });
});


// /api/settings/:compId?sessionId=true to recieve a sessionId

app.get('/api/settings/:compId', function (req, res) {

  // var instance = req.header('X-Wix-Instance');
  var currInstance = {
    instanceId: 'whatever',
    compId: 'however'
  }; //new WixWidget(instance, req.params.compId);

  pg.connect(connectionString, function (err, client, done) {
    if (err) { console.error('db connection error: ', err); }

    db.widget.getSettings(client, currInstance, function (err, widgetSettings) {
      var settingsResponse = {
        code: httpStatus.OK,
        userEmail: '',
        provider: '',
        settings: {}
      };

      if (widgetSettings !== null) {
        settingsResponse.userEmail = widgetSettings.user_email;
        settingsResponse.provider = widgetSettings.curr_provider;
        settingsResponse.settings = JSON.parse(widgetSettings.settings);
      }

      if (req.query.sessionId === 'true') {
        db.session.open(client, currInstance, function (err, sessionId) {
          settingsResponse.sessionId = sessionId;
          done();
          pg.end();
          req.status(httpStatus.OK);
          return res.json({widgetSettings: settingsResponse});
        });
      }

      done();
      pg.end();
      req.status(httpStatus.OK);
      res.json({widgetSettings: settingsResponse});
    });
  });
});


app.put('/api/settings/:compId', function (req, res) {
  // var instance = req.header('X-Wix-Instance');
  var currInstance = {
    instanceId: 'whatever',
    compId: 'however'
  }; //new WixWidget(instance, req.params.compId);

  var widgetSettings = req.body.widgetSettings;
  var userEmail = widgetSettings.userEmail.trim();
  var isValidSettings = widgetSettings &&
                        (userEmail === '' ||
                         validator.isEmail(userEmail)) &&
                        validator.isJSON(widgetSettings.settings);

  if (!isValidSettings) {
    return res.json(setError(res, 'invalid request format', httpStatus.BAD_REQUEST));
  }

  var settingsRecieved = {
    userEmail: userEmail,
    provider: null, // do not update provider
    settings: JSON.stringfy(widgetSettings.settings)
  };
  pg.connect(connectionString, function (err, client, done) {
    if (err) { console.error('db connection error: ', err); }
    db.widget.updateSettings(client, currInstance, settingsRecieved, function (err, updatedWidgetSettings) {

      if (err) {
        db.widget.insertSettings(client, currInstance, settingsRecieved, function (err) {
          done();
          pg.end();
          req.status(httpStatus.OK);
          return res.json({code: httpStatus.OK});
        });
      }
      done();
      pg.end();
      req.status(httpStatus.OK);
      res.json({code: httpStatus.OK});
    });
  });
});



module.exports = app;
