# Personas · API y dashboard

Repositorio independiente del servidor de analítica y su dashboard local. La app móvil se mantiene en `ChristianGuan/personas-flutter` y se conecta por HTTPS; no comparte archivos ni credenciales de BD con este repositorio.

## Requisitos

Node.js 24, npm y PostgreSQL 17 (o Docker Desktop).

## Configuración

```sh
cp Backend/.env.example Backend/.env
cd Backend
npm ci
```

Edita `Backend/.env`: `DATABASE_URL`, `POSTGRES_PASSWORD` y `ADMIN_TOKEN` (al menos 32 caracteres). No se incluyen credenciales reales. `HOST`/`PORT` controlan la API y `DASHBOARD_HOST`/`DASHBOARD_PORT` el dashboard; ambos escuchan en loopback de forma predeterminada.

Desde `Backend/`:

```sh
docker compose up -d --wait
npm run migrate
npm run dev
```

En otra terminal desde `Backend/`:

```sh
npm run dashboard
```

- API: http://127.0.0.1:3000
- Swagger: http://127.0.0.1:3000/docs
- Dashboard: http://127.0.0.1:3001

El botón **Actualizar desde BD** consulta los datos actuales. El dashboard usa PostgreSQL y la API desde el servidor local; el token administrador no llega al navegador. Para acceder remotamente al dashboard debe añadirse autenticación antes de exponerlo.

## Estructura

- `Backend/`: API NestJS, validación, PostgreSQL, migraciones y pruebas.
- `dashboard-metricas/dist/`: interfaz sin compilación adicional.
- `dashboard-metricas/tests/`: pruebas y datos sintéticos.

La separación se hizo desde `busqueda_fotos_app`, backend base `69203ff`, incorporando el dashboard local. El repositorio anterior se conserva.

## Validación

```sh
npm run build
npm test
```

`npm test` ejecuta validación y pruebas del dashboard. Las pruebas de integración del backend necesitan `TEST_DATABASE_URL` y crean esquemas aislados. No apuntar esa variable a una BD sin permisos de creación/eliminación de esquemas.

Las capturas `dashboard-metricas/dist/data.json` y los reportes generados se ignoran. Para exportar una captura local: `cd Backend && npm run dashboard:export`. Nunca subir capturas con datos operativos al repositorio.

Ver [contrato de la API](Backend/README.md).
