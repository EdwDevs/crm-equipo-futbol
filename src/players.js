export const PLAYER_ROLES = {
    arquero: 'Arquero',
    cierre: 'Cierre',
    ala: 'Ala',
    pivote: 'Pivote',
    suplente: 'Suplente'
};

export const AVAILABILITY_STATES = {
    disponible: 'Disponible',
    lesionado: 'Lesionado',
    ausente: 'Ausente',
    duda: 'Duda'
};

// IMPORTANTE: el CRUD/render de jugadores vive en main.js durante la migración porque usa listeners compartidos.
// Este módulo concentra catálogos de jugadores para que futuras pantallas no repliquen roles ni disponibilidad.
