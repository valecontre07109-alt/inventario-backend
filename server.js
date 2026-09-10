const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const SECRET = "clave_secreta_inventario";

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Crear carpeta uploads si no existe (fotos de materiales - Guía 16)
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}
// Sirve las fotos guardadas: http://<ip>:3000/uploads/nombre-archivo.jpg
app.use("/uploads", express.static("uploads"));

// Configuración de multer: guarda el archivo con un nombre único y
// conserva la extensión original (.jpg, .png, etc.)
const almacenamientoFotos = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/"),
    filename: (req, file, cb) => {
        const sufijo = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, "material-" + sufijo + path.extname(file.originalname));
    }
});
const upload = multer({ storage: almacenamientoFotos });

// Crear carpeta qrs si no existe
if (!fs.existsSync('./qrs')) {
    fs.mkdirSync('./qrs');
}

function generarQR(materialId, nombre) {
    const ruta = `./qrs/${materialId}.png`;
    QRCode.toFile(ruta, materialId, {
        color: { dark: '#000000', light: '#FFFFFF' },
        margin: 2,
        width: 300
    }, function (err) {
        if (err) throw err;
        console.log(`QR generado en: ${ruta}`);
    });
}
generarQR("3", "ladrillos");

// Sirve los códigos QR generados: https://<tu-app>.up.railway.app/qrs/3.png
app.use("/qrs", express.static("qrs"));

// Conexión a MySQL/MariaDB usando variables de entorno de Railway.
// En Railway, ve a tu servicio de base de datos -> pestaña "Variables"
// y ahí verás MYSQLHOST, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE, MYSQLPORT
// ya generados automáticamente; no necesitas copiarlos a mano si usas
// la variable de referencia ${{MySQL.MYSQLHOST}} etc. en el servicio del backend.
const conexion = mysql.createConnection({
    host: process.env.MYSQLHOST || "localhost",
    user: process.env.MYSQLUSER || "root",
    password: process.env.MYSQLPASSWORD || "",
    database: process.env.MYSQLDATABASE || "railway",
    port: process.env.MYSQLPORT || 3306
});

conexion.connect((err) => {
    if (err) {
        throw err;
    }

    console.log("Conectado a MariaDB (XAMPP)");
});

// ===============================
// AUTENTICACIÓN (Guía 13)
// ===============================

// Revisa que venga un token JWT válido en el header "authorization"
function verificarToken(req, res, next) {
    const token = req.headers["authorization"];
    if (!token) {
        return res.status(401).json({ status: "error", mensaje: "Token requerido" });
    }
    jwt.verify(token, SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).json({ status: "error", mensaje: "Token inválido" });
        }
        req.usuario = decoded; // { id, rol }
        next();
    });
}

// Va DESPUÉS de verificarToken: solo deja pasar si el rol es admin
function verificarAdmin(req, res, next) {
    if (req.usuario.rol !== "admin") {
        return res.status(403).json({ status: "error", mensaje: "Acceso denegado: requiere rol admin" });
    }
    next();
}

// ===============================
// RUTA PRINCIPAL
// ===============================

app.get("/", (req, res) => {
    res.send("Bienvenido a Inventario API");
});

// ===============================
// REGISTRO DE USUARIOS
// ===============================

app.post("/registro", (req, res) => {
    const { nombre, correo, password, rol } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 8);

    const sql = "INSERT INTO usuarios (nombre, correo, password, rol) VALUES (?, ?, ?, ?)";
    conexion.query(sql, [nombre, correo, hashedPassword, rol || "maestro"], (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err });
        res.json({ status: "ok", mensaje: "Usuario registrado" });
    });
});

// ===============================
// LOGIN (con JWT)
// ===============================

app.post("/login", (req, res) => {
    const { correo, password } = req.body;
    const sql = "SELECT * FROM usuarios WHERE correo = ?";

    conexion.query(sql, [correo], (err, result) => {
        if (err || result.length === 0) {
            return res.json({ status: "error", mensaje: "Usuario no encontrado" });
        }

        const usuario = result[0];
        const passwordValido = bcrypt.compareSync(password, usuario.password);
        if (!passwordValido) {
            return res.json({ status: "error", mensaje: "Contraseña incorrecta" });
        }

        const token = jwt.sign({ id: usuario.id, rol: usuario.rol }, SECRET, { expiresIn: "1h" });
        res.json({
            status: "ok",
            token,
            rol: usuario.rol,
            nombre: usuario.nombre
        });
    });
});

// ===============================
// REGISTRAR MATERIALES (solo admin)
// ===============================

app.post("/materiales", verificarToken, verificarAdmin, upload.single("foto"), (req, res) => {

    const { nombre, cantidad, estado, categoria } = req.body;
    const foto = req.file ? req.file.path.replace(/\\/g, "/") : null;

    const sql = `
        INSERT INTO materiales 
        (nombre, cantidad, estado, categoria, foto) 
        VALUES (?, ?, ?, ?, ?)
    `;

    conexion.query(
        sql,
        [nombre, cantidad, estado, categoria, foto],
        (err, result) => {

            if (err) {
                res.json({
                    status: "error",
                    mensaje: err
                });
            } else {
                res.json({
                    status: "ok",
                    mensaje: "Material registrado",
                    id: result.insertId
                });
            }
        }
    );
});

// ===============================
// EDITAR MATERIAL (nombre, cantidad, estado, categoría y opcionalmente
// una nueva foto) - solo admin - Guía 16
// ===============================

app.put("/materiales/:id", verificarToken, verificarAdmin, upload.single("foto"), (req, res) => {
    const { nombre, cantidad, estado, categoria } = req.body;
    const nuevaFoto = req.file ? req.file.path.replace(/\\/g, "/") : null;

    const campos = ["nombre = ?", "cantidad = ?", "estado = ?", "categoria = ?"];
    const params = [nombre, cantidad, estado, categoria];

    // Solo se actualiza la foto si el usuario seleccionó una nueva
    if (nuevaFoto) {
        campos.push("foto = ?");
        params.push(nuevaFoto);
    }

    params.push(req.params.id);
    const sql = `UPDATE materiales SET ${campos.join(", ")} WHERE id = ?`;

    conexion.query(sql, params, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else if (result.affectedRows === 0) {
            res.json({ status: "fail", mensaje: "No se encontró ese material" });
        } else {
            res.json({ status: "ok", mensaje: "Material actualizado" });
        }
    });
});

// ===============================
// ELIMINAR MATERIAL - solo admin - Guía 16
// ===============================

app.delete("/materiales/:id", verificarToken, verificarAdmin, (req, res) => {
    const sql = "DELETE FROM materiales WHERE id = ?";
    conexion.query(sql, [req.params.id], (err, result) => {
        if (err) {
            // Si el material tiene préstamos asociados, MySQL puede rechazar
            // el borrado por la llave foránea; el mensaje de error lo explica.
            res.json({ status: "error", mensaje: err });
        } else if (result.affectedRows === 0) {
            res.json({ status: "fail", mensaje: "No se encontró ese material" });
        } else {
            res.json({ status: "ok", mensaje: "Material eliminado" });
        }
    });
});

// ===============================
// REGISTRAR PRÉSTAMOS (admin o maestro logueado)
// ===============================

app.post("/prestamos", verificarToken, (req, res) => {

    const {
        material_id,
        fecha_prestamo,
        maestro
    } = req.body;

    const sqlPermiso = "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE";

    conexion.query(sqlPermiso, [maestro, material_id], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else if (result.length === 0) {
            res.json({ status: "fail", mensaje: "No tienes permiso para prestar este material" });
        } else {
            const sql = `
                INSERT INTO prestamos
                (material_id, fecha_prestamo, maestro)
                VALUES (?, ?, ?)
            `;

            conexion.query(
                sql,
                [
                    material_id,
                    fecha_prestamo,
                    maestro
                ],
                (err2, result2) => {

                    if (err2) {
                        res.json({
                            status: "error",
                            mensaje: err2
                        });
                    } else {
                        res.json({
                            status: "ok",
                            mensaje: "Préstamo registrado"
                        });
                    }
                }
            );
        }
    });
});

// ===============================
// LISTAR PRÉSTAMOS (con nombre del material) - cualquier usuario logueado
// ===============================

app.get("/prestamos", verificarToken, (req, res) => {
    const sql = `
        SELECT prestamos.id, materiales.nombre AS material,
               prestamos.fecha_prestamo, prestamos.fecha_devolucion, prestamos.maestro
        FROM prestamos
        INNER JOIN materiales ON prestamos.material_id = materiales.id
    `;
    conexion.query(sql, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json(result);
        }
    });
});

// ===============================
// ACTUALIZAR PRÉSTAMO (corregir fecha de devolución manualmente) - cualquier usuario logueado
// ===============================

app.put("/prestamos/:id", verificarToken, (req, res) => {
    const { fecha_devolucion } = req.body;
    const sql = "UPDATE prestamos SET fecha_devolucion = ? WHERE id = ?";
    conexion.query(sql, [fecha_devolucion, req.params.id], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json({ status: "ok", mensaje: "Préstamo actualizado" });
        }
    });
});

// ===============================
// MARCAR DEVOLUCIÓN POR ID DE PRÉSTAMO (botón check verde en la lista)
// ===============================

app.put("/prestamos/devolver/id/:id", verificarToken, (req, res) => {
    const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?";
    conexion.query(sql, [req.params.id], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else if (result.affectedRows === 0) {
            res.json({ status: "fail", mensaje: "No se encontró ese préstamo" });
        } else {
            res.json({ status: "ok", mensaje: "Material devuelto" });
        }
    });
});

// ===============================
// MARCAR DEVOLUCIÓN POR ID DE MATERIAL (escaneo QR)
// ===============================

app.put("/prestamos/devolver/qr/:material_id", verificarToken, (req, res) => {
    const materialId = parseInt(req.params.material_id, 10);

    if (isNaN(materialId)) {
        return res.json({ status: "error", mensaje: "Código QR inválido" });
    }

    const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE material_id = ? AND fecha_devolucion IS NULL";
    conexion.query(sql, [materialId], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else if (result.affectedRows === 0) {
            // No había ningún préstamo pendiente de devolución para este material
            res.json({
                status: "fail",
                mensaje: "No hay un préstamo pendiente para este material"
            });
        } else {
            res.json({ status: "ok", mensaje: "Entrega registrada" });
        }
    });
});

// ===============================
// REPORTES Y ESTADÍSTICAS (solo admin)
// ===============================

// Total de préstamos
app.get("/reportes/total", verificarToken, verificarAdmin, (req, res) => {
    const sql = "SELECT COUNT(*) AS total FROM prestamos";
    conexion.query(sql, (err, result) => {
        if (err) res.json({ status: "error", mensaje: err });
        else res.json(result[0]);
    });
});

// Préstamos pendientes (sin devolución)
app.get("/reportes/pendientes", verificarToken, verificarAdmin, (req, res) => {
    const sql = "SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL";
    conexion.query(sql, (err, result) => {
        if (err) res.json({ status: "error", mensaje: err });
        else res.json(result[0]);
    });
});

// Préstamos devueltos
app.get("/reportes/devueltos", verificarToken, verificarAdmin, (req, res) => {
    const sql = "SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL";
    conexion.query(sql, (err, result) => {
        if (err) res.json({ status: "error", mensaje: err });
        else res.json(result[0]);
    });
});

// ===============================
// DASHBOARD (métricas clave) - solo admin  [Guía 14]
// ===============================

app.get("/dashboard", verificarToken, verificarAdmin, (req, res) => {
    const sql = `
        SELECT
            (SELECT COUNT(*) FROM materiales) AS total_materiales,
            (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NULL) AS prestados,
            (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NOT NULL) AS devueltos,
            (SELECT COUNT(*) FROM materiales WHERE estado = 'dañado') AS danados
    `;
    conexion.query(sql, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json(result[0]);
        }
    });
});

// ===============================
// NOTIFICACIONES (cualquier usuario logueado)
// ===============================

app.get("/notificaciones/:maestro", verificarToken, (req, res) => {
    const sql = "SELECT * FROM prestamos WHERE maestro = ? AND fecha_devolucion IS NULL";
    conexion.query(sql, [req.params.maestro], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json(result);
        }
    });
});

// ===============================
// PERMISOS (solo admin)
// ===============================

app.post("/permisos", verificarToken, verificarAdmin, (req, res) => {
    const { maestro, material_id, puede_ver, puede_prestar, puede_devolver } = req.body;
    const sql = "INSERT INTO permisos (maestro, material_id, puede_ver, puede_prestar, puede_devolver) VALUES (?, ?, ?, ?, ?)";
    conexion.query(sql, [maestro, material_id, puede_ver, puede_prestar, puede_devolver], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json({ status: "ok", mensaje: "Permiso asignado" });
        }
    });
});

app.get("/permisos", verificarToken, verificarAdmin, (req, res) => {
    const sql = `
        SELECT permisos.id, permisos.maestro, materiales.nombre AS material,
               permisos.puede_ver, permisos.puede_prestar, permisos.puede_devolver
        FROM permisos
        INNER JOIN materiales ON permisos.material_id = materiales.id
    `;
    conexion.query(sql, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json(result);
        }
    });
});

// Editar un permiso existente (togglear puede_ver / puede_prestar / puede_devolver)
// Guía 15: se identifica el permiso por su id (la app solo muestra nombres al usuario)
app.put("/permisos/:id", verificarToken, verificarAdmin, (req, res) => {
    const { puede_ver, puede_prestar, puede_devolver } = req.body;

    const campos = [];
    const params = [];
    if (puede_ver !== undefined) { campos.push("puede_ver = ?"); params.push(puede_ver); }
    if (puede_prestar !== undefined) { campos.push("puede_prestar = ?"); params.push(puede_prestar); }
    if (puede_devolver !== undefined) { campos.push("puede_devolver = ?"); params.push(puede_devolver); }

    if (campos.length === 0) {
        return res.json({ status: "fail", mensaje: "Nada que actualizar" });
    }

    const sql = `UPDATE permisos SET ${campos.join(", ")} WHERE id = ?`;
    params.push(req.params.id);

    conexion.query(sql, params, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else if (result.affectedRows === 0) {
            res.json({ status: "fail", mensaje: "No se encontró ese permiso" });
        } else {
            res.json({ status: "ok", mensaje: "Permiso actualizado" });
        }
    });
});

// ===============================
// REPORTES FILTRADOS (por maestro, material y rango de fechas) - solo admin
// Guía 17: historial detallado de préstamos con filtros y exportación
// ===============================
// Filtro compartido por /reportes/filtrados, /reportes/pdf y /reportes/excel

function construirFiltroReportes(query) {
    const { maestro, material, fecha_inicio, fecha_fin } = query;
    let sql = `
        SELECT prestamos.id, materiales.nombre AS material,
               prestamos.fecha_prestamo, prestamos.fecha_devolucion, prestamos.maestro
        FROM prestamos
        INNER JOIN materiales ON prestamos.material_id = materiales.id
        WHERE 1 = 1
    `;
    const params = [];

    if (maestro) {
        sql += " AND prestamos.maestro = ?";
        params.push(maestro);
    }
    if (material) {
        sql += " AND materiales.nombre = ?";
        params.push(material);
    }
    if (fecha_inicio) {
        sql += " AND DATE(prestamos.fecha_prestamo) >= ?";
        params.push(fecha_inicio);
    }
    if (fecha_fin) {
        sql += " AND DATE(prestamos.fecha_prestamo) <= ?";
        params.push(fecha_fin);
    }

    sql += " ORDER BY prestamos.fecha_prestamo DESC";
    return { sql, params };
}

// Resultados en JSON, para mostrarlos como tarjetas en la app
app.get("/reportes/filtrados", verificarToken, verificarAdmin, (req, res) => {
    const { sql, params } = construirFiltroReportes(req.query);
    conexion.query(sql, params, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json(result);
        }
    });
});

// Exportar a PDF
app.get("/reportes/pdf", verificarToken, verificarAdmin, (req, res) => {
    const { sql, params } = construirFiltroReportes(req.query);
    conexion.query(sql, params, (err, result) => {
        if (err) {
            return res.status(500).json({ status: "error", mensaje: err });
        }

        const doc = new PDFDocument({ margin: 40 });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="reporte.pdf"');
        doc.pipe(res);

        doc.fontSize(16).text("Reporte de Préstamos - INFRAMEN", { align: "center" });
        doc.moveDown();

        if (req.query.maestro) {
            doc.fontSize(10).text(`Maestro: ${req.query.maestro}`);
        }
        if (req.query.material) {
            doc.fontSize(10).text(`Material: ${req.query.material}`);
        }
        if (req.query.fecha_inicio || req.query.fecha_fin) {
            doc.fontSize(10).text(
                `Rango: ${req.query.fecha_inicio || "..."} a ${req.query.fecha_fin || "..."}`
            );
        }
        doc.moveDown();

        if (result.length === 0) {
            doc.fontSize(11).text("No se encontraron resultados con estos filtros.");
        } else {
            result.forEach((p) => {
                doc.fontSize(11).text(`Material: ${p.material}   |   Maestro: ${p.maestro}`);
                doc.fontSize(9).fillColor("#555555").text(
                    `Préstamo: ${p.fecha_prestamo}   Devolución: ${p.fecha_devolucion ?? "Pendiente"}`
                );
                doc.fillColor("#000000").moveDown(0.6);
            });
        }

        doc.end();
    });
});

// Exportar a Excel
app.get("/reportes/excel", verificarToken, verificarAdmin, (req, res) => {
    const { sql, params } = construirFiltroReportes(req.query);
    conexion.query(sql, params, async (err, result) => {
        if (err) {
            return res.status(500).json({ status: "error", mensaje: err });
        }

        try {
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet("Préstamos");

            sheet.columns = [
                { header: "ID", key: "id", width: 8 },
                { header: "Material", key: "material", width: 26 },
                { header: "Maestro", key: "maestro", width: 22 },
                { header: "Fecha préstamo", key: "fecha_prestamo", width: 22 },
                { header: "Fecha devolución", key: "fecha_devolucion", width: 22 },
            ];
            sheet.getRow(1).font = { bold: true };

            result.forEach((p) => {
                sheet.addRow({
                    id: p.id,
                    material: p.material,
                    maestro: p.maestro,
                    fecha_prestamo: p.fecha_prestamo,
                    fecha_devolucion: p.fecha_devolucion ?? "Pendiente",
                });
            });

            res.setHeader(
                "Content-Type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            );
            res.setHeader("Content-Disposition", 'attachment; filename="reporte.xlsx"');

            await workbook.xlsx.write(res);
            res.end();
        } catch (e) {
            res.status(500).json({ status: "error", mensaje: e.toString() });
        }
    });
});

// ===============================
// LISTAS PARA LOS MENÚS (cualquier usuario logueado)
// ===============================

app.get("/maestros", verificarToken, (req, res) => {
    const sql = "SELECT nombre FROM usuarios WHERE rol = 'maestro'";
    conexion.query(sql, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json(result);
        }
    });
});

app.get("/materiales", verificarToken, (req, res) => {
    const sql = "SELECT id, nombre, cantidad, estado, categoria, foto FROM materiales";
    conexion.query(sql, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err });
        } else {
            res.json(result);
        }
    });
});

const PUERTO = process.env.PORT || 8080;
app.listen(PUERTO, () => {
    console.log(`Servidor en el puerto ${PUERTO}`);
});
