
/**
 * Pause for a specified number of seconds.
 * @param x Minimum number of seconds.
 * @param y Maximum number of seconds (optional).
 */
 const sleep = (x, y) => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }


  return new Promise(resolve => setTimeout(resolve, timeout));
}


 const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}
module.exports = { sleep, corsHeaders }