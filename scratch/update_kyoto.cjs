const fs = require('fs');
const file = 'src/watch/assets/kyoto/Kyoto-I.xml';
let content = fs.readFileSync(file, 'utf8');

// 1. Update angleForJapanHour(X) -> angleForJapanHour(X, topAnchorSolarNoon)
content = content.replace(/angleForJapanHour\(\s*([\d.]+)\s*\)/g, 'angleForJapanHour($1, topAnchorSolarNoon)');

// 2. Update X*pi/12+pi -> X*pi/12+pi - solarNoonAngle()
content = content.replace(/(\d+\.\d+)\*pi\/12\+pi\s*:/g, '$1*pi/12+pi - solarNoonAngle() :');

// 3. Update the day/night ring
// <QdayNightRing name='daytime' ... masterOffset='pi' />
content = content.replace(/masterOffset='pi'/, "masterOffset='pi - solarNoonAngle()'");

// 4. Update the jhr hand
// <hand name='jhr' ... angle='kyMode==0 ? hour24ValueAngle()+pi : japanHourValueAngle()' />
content = content.replace(/hour24ValueAngle\(\)\+pi\s*:/, 'hour24ValueAngle()+pi - solarNoonAngle() :');

fs.writeFileSync(file, content);
console.log('Updated Kyoto-I.xml');
