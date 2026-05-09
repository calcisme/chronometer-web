const fs = require('fs');
const file = 'src/watch/assets/kyoto/Kyoto-I.xml';
let content = fs.readFileSync(file, 'utf8');

// Update integer-based 24-hour markers: X*pi/12+pi -> X*pi/12+pi - solarNoonAngle()
content = content.replace(/(\d+)\*pi\/12\+pi\s*:/g, '$1*pi/12+pi - solarNoonAngle() :');

fs.writeFileSync(file, content);
console.log('Fixed n24 labels in Kyoto-I.xml');
