export const OFFICIAL_TOURNAMENTS = ["Interempresas anillo vial", "Intercompany HIC"];

export const getMatchesChronological = (matches = []) => [...matches].sort((a, b) => {
    const dateA = new Date(a.date || 0).getTime();
    const dateB = new Date(b.date || 0).getTime();
    return dateA - dateB;
});

export const getResultClass = (result) => result === 'Victoria'
    ? 'text-success'
    : (result === 'Derrota' ? 'text-danger' : 'text-primary');

export const getResultBadgeClass = (result) => result === 'Victoria'
    ? 'bg-success/10 text-success border-success/20'
    : (result === 'Derrota'
        ? 'bg-danger/10 text-danger border-danger/20'
        : 'bg-primary/10 text-primary border-primary/20');

export const getResultShort = (result) => result === 'Victoria' ? 'V' : (result === 'Empate' ? 'E' : 'D');

// IMPORTANTE: estas utilidades normalizan partidos antiguos y nuevos antes de renderizar listas o detalle.
