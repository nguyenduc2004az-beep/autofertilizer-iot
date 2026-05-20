const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
});

const parts = formatter.formatToParts(new Date());
console.log('parts:', parts);

const partValues = {};
for (const part of parts) {
    partValues[part.type] = part.value;
}

const vnYear = parseInt(partValues.year, 10);
const vnMonth = parseInt(partValues.month, 10) - 1; // 0-indexed
const vnDay = parseInt(partValues.day, 10);
const vnHour = parseInt(partValues.hour, 10);
const vnMinute = parseInt(partValues.minute, 10);

console.log('vnYear:', vnYear);
console.log('vnMonth:', vnMonth);
console.log('vnDay:', vnDay);
console.log('vnHour:', vnHour);
console.log('vnMinute:', vnMinute);
