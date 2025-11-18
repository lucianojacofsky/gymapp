const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

// DB SQLite
const db = new sqlite3.Database('./gymload.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      exercise TEXT NOT NULL,
      weight REAL NOT NULL,
      reps INTEGER NOT NULL,
      rpe REAL,
      date TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      exercise TEXT NOT NULL,
      reps INTEGER NOT NULL,
      weight REAL NOT NULL,
      date TEXT NOT NULL,
      UNIQUE(user_id, exercise, reps),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS main_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      typical_reps TEXT NOT NULL,
      UNIQUE(user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helpers
function getUser(username, cb) {
  db.get('SELECT * FROM users WHERE username = ?', [username], cb);
}

function authMiddleware(req, res, next) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Falta usuario o contraseña' });
  }
  getUser(username, (err, user) => {
    if (err) return res.status(500).json({ error: 'Error de base de datos' });
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    req.user = user;
    next();
  });
}

// --------- RUTAS AUTH ---------

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }
  db.run(
    'INSERT INTO users (username, password) VALUES (?, ?)',
    [username, password],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'El usuario ya existe' });
        }
        return res.status(500).json({ error: 'Error al registrar usuario' });
      }
      res.json({ success: true, message: 'Usuario registrado correctamente' });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }
  getUser(username, (err, user) => {
    if (err) return res.status(500).json({ error: 'Error de base de datos' });
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    res.json({ success: true, message: 'Login OK' });
  });
});

// --------- DATA POR USUARIO ---------

app.post('/api/data', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const result = {};

  db.all(
    'SELECT id, exercise, reps, weight, date FROM prs WHERE user_id = ? ORDER BY exercise, reps',
    [userId],
    (err, rowsPrs) => {
      if (err) return res.status(500).json({ error: 'Error leyendo PRs' });
      result.prs = rowsPrs || [];

      db.all(
        'SELECT id, exercise, weight, reps, rpe, date FROM sets WHERE user_id = ? ORDER BY date DESC',
        [userId],
        (err2, rowsSets) => {
          if (err2) return res.status(500).json({ error: 'Error leyendo sets' });
          result.sets = rowsSets || [];

          db.all(
            'SELECT id, name, typical_reps FROM main_exercises WHERE user_id = ? ORDER BY name',
            [userId],
            (err3, rowsMain) => {
              if (err3) {
                return res.status(500).json({ error: 'Error leyendo ejercicios principales' });
              }
              result.mainExercises = rowsMain || [];
              res.json(result);
            }
          );
        }
      );
    }
  );
});

// --------- GUARDAR SERIE + ACTUALIZAR PR ---------

app.post('/api/series', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const { exercise, weight, reps, rpe } = req.body;

  if (!exercise || !weight || !reps) {
    return res.status(400).json({ error: 'Faltan datos de la serie' });
  }

  const now = new Date().toISOString();

  db.run(
    'INSERT INTO sets (user_id, exercise, weight, reps, rpe, date) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, exercise, weight, reps, rpe || null, now],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Error al guardar la serie' });
      }

      db.get(
        'SELECT * FROM prs WHERE user_id = ? AND exercise = ? AND reps = ?',
        [userId, exercise, reps],
        (err2, prRow) => {
          if (err2) return res.status(500).json({ error: 'Error al consultar PR' });

          const updateDataAndReturn = () => {
            db.all(
              'SELECT id, exercise, reps, weight, date FROM prs WHERE user_id = ? ORDER BY exercise, reps',
              [userId],
              (err3, prsRows) => {
                if (err3) return res.status(500).json({ error: 'Error leyendo PRs' });
                db.all(
                  'SELECT id, exercise, weight, reps, rpe, date FROM sets WHERE user_id = ? ORDER BY date DESC',
                  [userId],
                  (err4, setsRows) => {
                    if (err4) return res.status(500).json({ error: 'Error leyendo sets' });
                    res.json({ success: true, prs: prsRows || [], sets: setsRows || [] });
                  }
                );
              }
            );
          };

          if (!prRow) {
            db.run(
              'INSERT INTO prs (user_id, exercise, reps, weight, date) VALUES (?, ?, ?, ?, ?)',
              [userId, exercise, reps, weight, now],
              function (err3) {
                if (err3) return res.status(500).json({ error: 'Error al crear PR' });
                updateDataAndReturn();
              }
            );
          } else if (weight > prRow.weight) {
            db.run(
              'UPDATE prs SET weight = ?, date = ? WHERE id = ?',
              [weight, now, prRow.id],
              function (err3) {
                if (err3) return res.status(500).json({ error: 'Error al actualizar PR' });
                updateDataAndReturn();
              }
            );
          } else {
            updateDataAndReturn();
          }
        }
      );
    }
  );
});

// --------- BORRAR PRS / HISTORIAL ---------

app.post('/api/clear-prs', authMiddleware, (req, res) => {
  const userId = req.user.id;
  db.run('DELETE FROM prs WHERE user_id = ?', [userId], function (err) {
    if (err) return res.status(500).json({ error: 'Error al borrar PRs' });
    res.json({ success: true });
  });
});

app.post('/api/clear-sets', authMiddleware, (req, res) => {
  const userId = req.user.id;
  db.run('DELETE FROM sets WHERE user_id = ?', [userId], function (err) {
    if (err) return res.status(500).json({ error: 'Error al borrar historial' });
    res.json({ success: true });
  });
});

// --------- EJERCICIOS PRINCIPALES ---------

app.post('/api/main-exercise', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const { name, typical_reps } = req.body;

  if (!name || !typical_reps) {
    return res.status(400).json({ error: 'Faltan datos de ejercicio principal' });
  }

  db.get(
    'SELECT id FROM main_exercises WHERE user_id = ? AND name = ?',
    [userId, name],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Error al consultar ejercicio principal' });

      const returnAll = () => {
        db.all(
          'SELECT id, name, typical_reps FROM main_exercises WHERE user_id = ? ORDER BY name',
          [userId],
          (err2, rows) => {
            if (err2) return res.status(500).json({ error: 'Error leyendo ejercicios principales' });
            res.json({ success: true, mainExercises: rows || [] });
          }
        );
      };

      if (!row) {
        db.run(
          'INSERT INTO main_exercises (user_id, name, typical_reps) VALUES (?, ?, ?)',
          [userId, name, typical_reps],
          function (err2) {
            if (err2) return res.status(500).json({ error: 'Error al crear ejercicio principal' });
            returnAll();
          }
        );
      } else {
        db.run(
          'UPDATE main_exercises SET typical_reps = ? WHERE id = ?',
          [typical_reps, row.id],
          function (err2) {
            if (err2) return res.status(500).json({ error: 'Error al actualizar ejercicio principal' });
            returnAll();
          }
        );
      }
    }
  );
});

app.post('/api/delete-main-exercise', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Falta id de ejercicio principal' });

  db.run(
    'DELETE FROM main_exercises WHERE id = ? AND user_id = ?',
    [id, userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Error al borrar ejercicio principal' });
      db.all(
        'SELECT id, name, typical_reps FROM main_exercises WHERE user_id = ? ORDER BY name',
        [userId],
        (err2, rows) => {
          if (err2) {
            return res.status(500).json({ error: 'Error leyendo ejercicios principales' });
          }
          res.json({ success: true, mainExercises: rows || [] });
        }
      );
    }
  );
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
