/* Собирает всё в один файл dist/low-plat.html: node tools/build.js */
'use strict';
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace(/<script src="([^"]+)"><\/script>/g, function (m, src) {
  var code = fs.readFileSync(path.join(root, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return '<script>\n' + code + '</script>';
});
fs.writeFileSync(path.join(root, 'dist', 'low-plat.html'), html);
console.log('dist/low-plat.html', html.length, 'байт');
