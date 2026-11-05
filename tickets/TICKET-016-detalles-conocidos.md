# [BUG-016] Detalles menores conocidos

- **Componente:** varios
- **Severidad:** 🟢 Baja
- **Estado:** ⏳ Pendiente

---

## 1. Lista
- **Filtro por nombre de estación:** busca texto suelto; escribir "a" muestra cualquier línea de subte o tren con una estación que contenga "a" (`js/features/markers.js`).
- **Recorridos sin `trip_id` a más de 1500 m:** se descartan desde que `busRouteMaxShapeDistanceMeters` bajó de 25000 a 1500 (`js/app/config.js`).
- **Alertas con datos dañados en origen:** GCBA manda el protobuf con bytes UTF-8 inválidos; el decodificador del worker es tolerante (`corrupted_input: true`), pero se pierden timestamps y períodos de vigencia largos.
- **Recarga del GTFS en D1:** no es viable en el plan Free (escribe más de 100k filas por día). Se resuelve con [TICKET-006](TICKET-006-gtfs-actualizacion-automatica.md) y dejando de usar D1 para recorridos.
