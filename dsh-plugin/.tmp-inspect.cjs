
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
for (const line of text.split('\n')) {
  if (!line.includes('assistant/message')) continue;
  const obj = JSON.parse(line);
  const data = obj.data ?? obj;
  const content = data.message?.content;
  console.log('KEYS', Object.keys(data), 'MSG KEYS', Object.keys(data.message ?? {}));
  console.log(JSON.stringify(content, null, 1).slice(0, 4000));
  break;
}
