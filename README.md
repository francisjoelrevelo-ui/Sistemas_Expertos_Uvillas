# UvillaDx · Diagnóstico de enfermedades de la uvilla

Aplicación web progresiva (PWA) híbrida —**Machine Learning + Sistema Experto**— para identificar enfermedades de la uvilla (*Physalis peruviana*) a partir de fotografías de hojas, frutos y tallos.

Proyecto académico · Universidad Politécnica Estatal del Carchi (UPEC) · Carrera de Computación · Sistemas Expertos 2026 B.

🌐 **App en línea:** https://francisjoelrevelo-ui.github.io/Sistemas_Expertos_Uvillas/

## Cómo funciona

1. **Visión artificial** (TensorFlow.js / Teachable Machine): clasifica la imagen según el órgano.
   - Hojas (8 clases) · Frutos (7 clases) · Tallos (4 clases) = 19 clases.
   - Sin modelo cargado se usa un simulador por análisis de color (solo demostración).
2. **Sistema experto** (`knowledgeBase.json`):
   - Reglas de control de confianza: rechazo < 50 %, reevaluación < 70 %, desempate si la diferencia es < 15 %.
   - Reglas de desempate por síntomas (esclerocios, textura, micelio, aspecto aceitoso…).
   - Reglas climáticas según temperatura y humedad relativa.
   - Combinación de factores de certeza: `FC = FC1 + FC2 × (1 − FC1)`.
3. **Ficha de manejo agronómico** para cada diagnóstico.
4. **Historial en la nube** (Supabase): con cuenta, los diagnósticos se sincronizan y se ven desde cualquier dispositivo. Sin conexión quedan en una cola local y se suben al reconectar. En modo invitado solo se guardan en el dispositivo.

## Configurar Supabase (una sola vez)

1. En Supabase → **SQL Editor** → *New query*, pegar y ejecutar [`supabase/schema.sql`](supabase/schema.sql). Crea la tabla `diagnosticos` con seguridad por fila (RLS): cada usuario solo ve los suyos.
2. En **Authentication → URL Configuration**, poner como *Site URL* `https://francisjoelrevelo-ui.github.io/Sistemas_Expertos_Uvillas/` (para que los enlaces de confirmación de correo vuelvan a la app).
3. La URL del proyecto y la clave *publishable* están en `CONFIG` al inicio de `app.js`. Nunca colocar ahí la *secret key*.

## Archivos

| Archivo | Contenido |
|---|---|
| `index.html` | Interfaz (Tailwind CSS vía CDN) |
| `app.js` | IndexedDB, cuentas (Supabase Auth), modelos TF.js, motor de inferencia, sincronización |
| `supabase/schema.sql` | Tabla `diagnosticos` y reglas de seguridad RLS |
| `sw.js` | Service Worker: caché offline y Background Sync |
| `manifest.json` | Manifiesto PWA |
| `knowledgeBase.json` | Enfermedades, clases, preguntas y reglas SI–ENTONCES |
| `servidor.ps1` | Servidor local para pruebas en Windows |

## Ejecutar en local

```powershell
powershell -ExecutionPolicy Bypass -File servidor.ps1
```

Abrir la dirección que muestra la consola (por defecto http://localhost:8080).

> La base de conocimiento es una síntesis; validar agentes causales y rangos climáticos con la cartilla de la Universidad de Nariño y un agrónomo.
