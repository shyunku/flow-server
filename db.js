const mysql = require("mysql2");
const conn = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

conn.connect((err) => {
  if (err) {
    console.error("DB connection failed:", err);
    return;
  }

  console.info("DB connection successful");
});

module.exports = {
  query: (sql, values) => {
    return new Promise((resolve, reject) => {
      conn.query(sql, values, (err, results) => {
        if (err) {
          return reject(err);
        }

        resolve(results);
      });
    });
  },
};
