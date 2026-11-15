// Builds public/index.html from src/app.html: inlines the figure drawings and the watermark.
// Run with: npm run build
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const fig = fs.readFileSync(path.join(root, 'src/figure.js'), 'utf8');
let html = fs.readFileSync(path.join(root, 'src/app.html'), 'utf8');
html = html.replace('/*__FIGURE__*/', () => fig);
const mark = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'public/img/mark.png')).toString('base64');
html = html.split('url("img/mark.png")').join('url("' + mark + '")');
fs.writeFileSync(path.join(root, 'public/index.html'), html);
console.log('built public/index.html', (html.length / 1024).toFixed(1) + ' KB');
