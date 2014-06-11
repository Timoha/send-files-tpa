'use strict';

var fs = require('fs');
var googleapis = require('googleapis');


function connect(callback) {
  googleapis
      .discover('drive', 'v1')
      .execute(callback);
}


function insertFile(client, oauth2Client, file, callback) {

  var fileDesc = {
    title: file.originalname,
    mimeType: file.mimetype,
  };

  console.log('insering file to google');

  client.drive.files.insert(fileDesc)
    .withMedia(file.mimetype, fs.readFileSync(file.path))
    .withAuthClient(oauth2Client)
    .execute(function (err, result) {
      if (err) { console.error('Inserting to Drive error:', err); }
      callback(err, result);
    });
}


module.exports = {
  insertFile: insertFile,
  connect: connect
};
