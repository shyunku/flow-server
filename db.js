const mysql = require("mysql2");
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
});

const poolPromise = pool.promise();

module.exports = {
  query: (sql, values) => {
    return new Promise((resolve, reject) => {
      poolPromise
        .query(sql, values)
        .then(([results, fields]) => {
          resolve(results);
        })
        .catch((err) => {
          reject(err);
        });
    });
  },
};
