export const FINE_VALUES = { yellow: 5000, red: 10000, blue: 15000 };
export const PAYMENT_TYPE_LABELS = {
    inscripcion: 'Inscripción',
    tarjeta: 'Tarjeta (multa)',
    arbitraje: 'Arbitraje'
};

export const getPaymentAmount = (payment) => Math.max(0, parseFloat(payment?.amount) || 0);

export const calculateMatchFine = (stats = {}) => {
    let fine = 0;
    fine += (stats.yellow || 0) * FINE_VALUES.yellow;
    fine += (stats.blue || 0) * FINE_VALUES.blue;
    fine += (stats.red || 0) * FINE_VALUES.red;
    return fine;
};

// IMPORTANTE: los helpers financieros reciben auth/players por inyección para no acoplar Firestore con cálculos.
export const createFinanceHelpers = ({ auth, getPlayers, showToast }) => {
    const getPaymentOrigin = () => {
        const user = auth.currentUser;
        // IMPORTANTE: el origen queda en cada pago para auditoría aun cuando el ingreso sea anónimo.
        return user?.email || user?.displayName || user?.uid || 'manual/local';
    };

    const getPlayerPaymentLedger = (playerId) => {
        const player = getPlayers().find(p => String(p.id) === String(playerId));
        return (player?.payments || [])
            .map(payment => ({ ...payment, playerId, playerName: player?.name || 'Sin jugador' }))
            .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    };

    const sumPaymentsByType = (playerId, type, matchId = null) => getPlayerPaymentLedger(playerId)
        .filter(payment => (payment.type || 'inscripcion') === type)
        .filter(payment => matchId === null || String(payment.matchId || '') === String(matchId))
        .reduce((sum, payment) => sum + getPaymentAmount(payment), 0);

    const getPlayerTotalPaidFromHistory = (player) => {
        const ledgerTotal = (player.payments || [])
            .filter(payment => (payment.type || 'inscripcion') === 'inscripcion')
            .reduce((sum, payment) => sum + getPaymentAmount(payment), 0);
        // IMPORTANTE: si aún no existe historial, se conserva compatibilidad con totalPaid antiguo.
        return ledgerTotal > 0 ? ledgerTotal : Math.max(0, parseFloat(player.totalPaid) || 0);
    };

    const getFinePaidFromHistory = (playerId, matchId, fallbackPaid = 0) => {
        const paidFromLedger = sumPaymentsByType(playerId, 'tarjeta', matchId);
        // IMPORTANTE: el historial de pagos manda; refereePayments queda como respaldo para datos viejos.
        return paidFromLedger > 0 ? paidFromLedger : Math.max(0, parseFloat(fallbackPaid) || 0);
    };

    const getRefereePaidFromHistory = (playerId, matchId, fallbackPaid = 0) => {
        const paidFromLedger = sumPaymentsByType(playerId, 'arbitraje', matchId);
        // IMPORTANTE: arbitraje también se recalcula desde pagos auditables cuando existan.
        return paidFromLedger > 0 ? paidFromLedger : Math.max(0, parseFloat(fallbackPaid) || 0);
    };

    const downloadCSV = (filename, rows) => {
        if (!rows.length) return showToast('No hay datos para exportar', true);

        const headers = Object.keys(rows[0]);
        const escapeCSV = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const csv = [headers.join(','), ...rows.map(row => headers.map(header => escapeCSV(row[header])).join(','))].join('\n');
        const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showToast('CSV exportado');
    };

    return {
        downloadCSV,
        getFinePaidFromHistory,
        getPaymentOrigin,
        getPlayerPaymentLedger,
        getPlayerTotalPaidFromHistory,
        getRefereePaidFromHistory,
        sumPaymentsByType
    };
};
