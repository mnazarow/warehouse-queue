process.env.DB_PATH = process.env.DB_PATH || '/tmp/sec_test.db';
process.env.PORT = process.env.PORT || '4998';
process.env.NODE_ENV = 'production';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Sklad-Test-2026';
module.paths.unshift(__dirname + '/node_modules');
require('module').Module._initPaths();
require(require('path').resolve(__dirname, '../../server.js'));
