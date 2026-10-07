'use strict';

// Shared by the hooks (capture.js, route.js) and the extension (src/ecologits.ts).
// ISO-8601 style timestamp in local time with a UTC offset,
// e.g. 2026-10-07T13:14:00.123+02:00

function localTimestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? '+' : '-'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

module.exports = { localTimestamp };
