import {
    auth,
    collection,
    db,
    deleteDoc,
    doc,
    getDocs,
    inMemoryPersistence,
    onAuthStateChanged,
    onSnapshot,
    query,
    setDoc,
    setPersistence,
    signInAnonymously,
    updateDoc,
    where,
    writeBatch
} from './firebase.js';
import { calculateMatchFine, createFinanceHelpers, PAYMENT_TYPE_LABELS } from './finance.js';
import { getResultBadgeClass, getResultClass, getResultShort, OFFICIAL_TOURNAMENTS } from './matches.js';
import { AVAILABILITY_STATES, PLAYER_ROLES } from './players.js';
import { calculateAdvancedMetricsForPlayers, formatSignedDecimal } from './stats.js';
import { FORMATIONS } from './tactics.js';
import {
    chartTooltipLabel,
    closeModal,
    escapeHTML,
    formatCOP,
    renderProgressRows,
    safeText,
    safeVal,
    setHidden,
    setWidth,
    showToast
} from './ui.js';

// IMPORTANTE: main.js conserva el estado compartido mientras cada módulo encapsula configuración, catálogos y cálculos críticos.
let currentTournament = null;
let currentTournamentCollection = "tournaments";
let currentPlayersCollection = "players";
let players = [];
let tournamentData = {};
let matchSelection = {};
let currentLineup = {};
let currentLineupMeta = {};
let selectedLineupId = '';
let activePosIndex = null;
let charts = {};
let unsubPlayers = null;
let unsubTournament = null;

const {
    downloadCSV,
    getFinePaidFromHistory,
    getPaymentOrigin,
    getPlayerPaymentLedger,
    getPlayerTotalPaidFromHistory,
    getRefereePaidFromHistory,
    sumPaymentsByType
} = createFinanceHelpers({ auth, getPlayers: () => players, showToast });

const calculateAdvancedMetrics = (matches = []) => calculateAdvancedMetricsForPlayers(players, matches);

window.closeModal = closeModal;
window.showToast = showToast;

// IMPORTANTE: centraliza nombres de jugadores para reutilizar datos nuevos como MVP y alineación.
const getPlayerName = (playerId) => players.find(p => String(p.id) === String(playerId))?.name || 'Sin jugador';

const destroyChart = (key) => {
    if (charts[key]) {
        charts[key].destroy();
        delete charts[key];
    }
};

window.showView = (viewName) => {
    document.querySelectorAll('main > div[id^="view-"]').forEach(div => div.classList.add('hidden'));
    const target = document.getElementById('view-' + viewName);
    if (target) target.classList.remove('hidden');

    document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active', 'text-white'));
    const activeBtn = document.getElementById('nav-' + viewName);
    if (activeBtn) activeBtn.classList.add('active', 'text-white');

    if (viewName === 'tactics') window.initTactics();
    if (viewName === 'stats') setTimeout(window.renderStatsCharts, 120);
};

// --- TORNEOS ---
async function loadTournamentsList() {
    try {
        const container = document.getElementById('tournamentButtons');
        if (container) {
            container.innerHTML = '<div class="text-xs text-slate-500 text-center py-2"><i class="fa-solid fa-spinner fa-spin"></i> Buscando datos...</div>';
        }

        const found = [];

        const snapRoot = await getDocs(query(collection(db, "tournaments")));
        snapRoot.forEach(d => found.push({
            id: d.id,
            ...d.data(),
            sourceColl: "tournaments",
            playerColl: "players"
        }));

        try {
            const snapLegacy = await getDocs(query(collection(db, "torneos")));
            snapLegacy.forEach(d => found.push({
                id: d.id,
                ...d.data(),
                sourceColl: "torneos",
                playerColl: "jugadores"
            }));
        } catch (e) {}

        if (container) {
            container.innerHTML = '';

            if (found.length === 0) {
                container.innerHTML = '<div class="text-xs text-red-400 text-center p-2">No se encontraron datos.</div>';
                return;
            }

            found.forEach(t => {
                const btn = document.createElement('button');
                const isActive = t.id === currentTournament;
                btn.className = `w-full text-left px-3 py-3 rounded-2xl text-xs font-bold transition mb-1 flex justify-between items-center border ${
                    isActive
                        ? 'bg-gradient-to-r from-amber-500 to-amber-400 text-ink border-amber-300 shadow-brand'
                        : 'bg-white/5 text-slate-300 border-white/8 hover:bg-white/10'
                }`;

                // IMPORTANTE: el nombre del torneo viene de Firestore; usar textContent evita ejecutar HTML externo.
                const nameBox = document.createElement('div');
                nameBox.className = 'truncate';
                nameBox.textContent = t.name || t.id;

                const statusBox = document.createElement('div');
                if (t.sourceColl === "torneos") {
                    const legacyBadge = document.createElement('span');
                    legacyBadge.className = 'badge-source bg-yellow-500 text-black';
                    legacyBadge.textContent = 'Legacy';
                    statusBox.appendChild(legacyBadge);
                }

                if (isActive) {
                    const checkIcon = document.createElement('i');
                    checkIcon.className = 'fa-solid fa-check ml-1';
                    statusBox.appendChild(checkIcon);
                }

                btn.append(nameBox, statusBox);
                btn.onclick = () => window.selectTournament(t.id, t.sourceColl, t.playerColl);
                container.appendChild(btn);
            });
        }

        if (!currentTournament && found.length > 0) {
            window.selectTournament(found[0].id, found[0].sourceColl, found[0].playerColl);
        }
    } catch (e) {
        console.error(e);
    }
}

window.selectTournament = (tId, tColl = "tournaments", pColl = "players") => {
    if (typeof unsubPlayers === 'function') {
        unsubPlayers();
        unsubPlayers = null;
    }
    if (typeof unsubTournament === 'function') {
        unsubTournament();
        unsubTournament = null;
    }

    currentTournament = tId;
    currentTournamentCollection = tColl;
    currentPlayersCollection = pColl;
    players = [];
    tournamentData = {};
    matchSelection = {};
    currentLineup = {};
    currentLineupMeta = {};
    selectedLineupId = '';
    activePosIndex = null;

    loadData();
    loadTournamentsList();
};

function loadData() {
    if (!currentTournament) return;

    const q = query(collection(db, currentPlayersCollection), where("tournament", "==", currentTournament));
    unsubPlayers = onSnapshot(q, (snapshot) => {
        players = snapshot.docs
            .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
            .sort((a, b) => (a.number || 0) - (b.number || 0));
        window.renderAll();
    });

    unsubTournament = onSnapshot(doc(collection(db, currentTournamentCollection), currentTournament), (docSnap) => {
        if (docSnap.exists()) {
            tournamentData = docSnap.data();
            const name = tournamentData.name || "Torneo";

            safeText('mobileTournamentBadge', name.toUpperCase());
            safeText('dashTournamentName', name);
            safeVal('confName', name);
            safeVal('confPrice', tournamentData.totalInscription || 0);

            if (tournamentData.matches && tournamentData.matches.some(m => !m.id)) {
                const fixedMatches = tournamentData.matches.map(m => (!m.id ? { ...m, id: crypto.randomUUID() } : m));
                updateDoc(docSnap.ref, { matches: fixedMatches });
            }

            window.renderAll();
        }
    });
}

window.createOfficialTournament = async (name) => {
    try {
        if (!name) {
            const baseName = tournamentData?.name || "Nuevo Torneo";
            name = prompt("Nombre del nuevo torneo", `${baseName} ${new Date().getFullYear()}`);
        }
        if (!name) return;

        const newTournamentRef = doc(collection(db, "tournaments"));
        const newTournamentId = newTournamentRef.id;
        const batch = writeBatch(db);
        const nowISO = new Date().toISOString();

        batch.set(newTournamentRef, {
            name,
            totalInscription: 0,
            inscriptionPerPlayer: 0,
            matches: [],
            stats: {},
            status: "active",
            createdAt: nowISO
        });

        if (currentTournament) {
            batch.update(doc(collection(db, currentTournamentCollection), currentTournament), {
                archived: true,
                status: "closed",
                closedAt: nowISO
            });
        }

        players.forEach((p) => {
            const { id, payments, totalPaid, cardDebt, finesCredit, tournament, ...rest } = p;
            const playerRef = doc(collection(db, "players"));
            batch.set(playerRef, {
                ...rest,
                tournament: newTournamentId,
                payments: [],
                totalPaid: 0,
                cardDebt: 0,
                finesCredit: 0
            });
        });

        await batch.commit();
        window.selectTournament(newTournamentId, "tournaments", "players");
        window.showToast("Nuevo torneo creado");
    } catch (e) {
        console.error(e);
        window.showToast("Error al crear torneo", true);
    }
};

window.deleteCurrentTournament = async () => {
    if (!currentTournament) return;
    if (!confirm("¿ELIMINAR TORNEO ACTUAL? SE BORRARÁ TODO.")) return;

    try {
        const q = query(collection(db, currentPlayersCollection), where("tournament", "==", currentTournament));
        const snap = await getDocs(q);

        const batchPromises = snap.docs.map(d => deleteDoc(d.ref));
        await Promise.all(batchPromises);

        await deleteDoc(doc(collection(db, currentTournamentCollection), currentTournament));

        window.showToast("Torneo eliminado");
        currentTournament = null;
        loadTournamentsList();
    } catch (e) {
        console.error(e);
        window.showToast("Error: " + e.message, true);
    }
};

window.purgeTrashTournaments = async () => {
    if (!confirm("¿Borrar torneos NO oficiales?")) return;

    try {
        const snap = await getDocs(collection(db, "tournaments"));
        const batchPromises = [];

        snap.forEach(d => {
            if (!OFFICIAL_TOURNAMENTS.includes(d.data().name)) {
                batchPromises.push(deleteDoc(d.ref));
            }
        });

        await Promise.all(batchPromises);
        window.showToast("Limpieza completada");
        loadTournamentsList();
    } catch (e) {
        console.error(e);
        window.showToast("Error al limpiar torneos", true);
    }
};

// --- DEUDAS ---
const calculatePlayerDebts = (matches) => {
    const playerDebts = {};
    const playerCredits = {};

    players.forEach(p => {
        playerDebts[p.id] = 0;
        // IMPORTANTE: abonos de tarjeta sin partido son créditos generales contra multas históricas.
        const ledgerCredit = (p.payments || [])
            .filter(payment => (payment.type || 'inscripcion') === 'tarjeta' && !payment.matchId)
            .reduce((sum, payment) => sum + getPaymentAmount(payment), 0);
        playerCredits[p.id] = Math.max(0, ledgerCredit || p.finesCredit || 0);
    });

    const sortedMatches = [...matches].sort((a, b) => new Date(a.date) - new Date(b.date));

    sortedMatches.forEach(m => {
        const details = m.playerDetails || {};
        const payments = m.refereePayments || {};
        const present = m.presentPlayers || [];

        present.forEach(pid => {
            if (playerDebts[pid] === undefined) playerDebts[pid] = 0;

            const stats = details[pid] || { yellow: 0, blue: 0, red: 0 };
            const fine = calculateMatchFine(stats);

            let fallbackPaid = Math.max(0, parseFloat(payments[pid]?.finesPaidAmount) || 0);
            if (!payments[pid]?.finesPaidAmount && payments[pid]?.paidFines) {
                fallbackPaid = fine;
            }

            // IMPORTANTE: fórmula de deuda de multa por partido = multa generada por tarjetas - pagos auditables de ese partido.
            // IMPORTANTE: los pagos del historial tienen prioridad; refereePayments solo respalda registros antiguos sin ledger.
            const finesPaidAmount = Math.min(fine, getFinePaidFromHistory(pid, m.id, fallbackPaid));
            playerDebts[pid] += Math.max(0, fine - finesPaidAmount);
        });
    });

    Object.keys(playerDebts).forEach(pid => {
        // IMPORTANTE: el crédito histórico se resta al final para cubrir las multas más antiguas sin volver saldos negativos.
        playerDebts[pid] = Math.max(0, playerDebts[pid] - (playerCredits[pid] || 0));
    });

    return playerDebts;
};

async function recalculateAllDebts(matchesOverride = null) {
    const matches = matchesOverride || tournamentData.matches;
    if (!matches) return;

    const playerDebts = calculatePlayerDebts(matches);
    const batch = writeBatch(db);
    let hasUpdates = false;

    Object.keys(playerDebts).forEach(pid => {
        const p = players.find(x => x.id === pid);
        if (p && p.cardDebt !== playerDebts[pid]) {
            batch.update(doc(collection(db, currentPlayersCollection), pid), { cardDebt: playerDebts[pid] });
            p.cardDebt = playerDebts[pid];
            hasUpdates = true;
        }
    });

    if (hasUpdates) await batch.commit();
}

// --- CHARTS ---
window.renderStatsCharts = () => {
    const matches = tournamentData.matches || [];

    [
        'results', 'attendance', 'goalsPerMatch', 'mvp',
        'goalsTrend', 'dashboardGoalsTrend'
    ].forEach(destroyChart);

    // IMPORTANTE: reutilizamos el cálculo avanzado para que gráficas, dashboard y tabla usen la misma fuente de verdad.
    const advanced = calculateAdvancedMetrics(matches);
    const wins = advanced.teamStats.pg;
    const draws = advanced.teamStats.pe;
    const losses = advanced.teamStats.pp;
    const gf = advanced.matches.map(m => m.goalsScored || 0);
    const gc = advanced.matches.map(m => m.goalsConceded || 0);
    const labels = advanced.matches.map((_, idx) => `P${idx + 1}`);
    const yellow = advanced.playerList.reduce((acc, p) => acc + p.yellow, 0);
    const blue = advanced.playerList.reduce((acc, p) => acc + p.blue, 0);
    const red = advanced.playerList.reduce((acc, p) => acc + p.red, 0);
    const playerStats = advanced.playerList;
    const hasMatches = matches.length > 0;
    const hasPlayers = players.length > 0;
    const totalPayments = players.reduce((acc, p) => acc + ((p.payments || []).length), 0);
    let totalPaid = 0;
    let totalDebt = 0;
    const cost = tournamentData.totalInscription || 0;

    const debtsFromHistory = calculatePlayerDebts(matches);
    players.forEach(p => {
        const paidFromHistory = getPlayerTotalPaidFromHistory(p);
        totalPaid += paidFromHistory;
        const indCost = players.length > 0 ? cost / players.length : 0;
        const debt = Math.max(0, indCost - paidFromHistory);
        totalDebt += debt + (debtsFromHistory[p.id] || 0);
    });

    setHidden('statsMatchesEmpty', hasMatches);
    setHidden('statsPlayersEmpty', hasPlayers);
    setHidden('statsPaymentsEmpty', totalPayments > 0);

    const totalResultCount = Math.max(wins + draws + losses, 1);
    renderProgressRows('statsResultsCards', [
        { label: 'Victorias', value: wins, display: `${wins} (${((wins / totalResultCount) * 100).toFixed(0)}%)`, badgeClass: 'bg-success/10 text-success', barClass: 'bg-success', valueClass: 'text-success' },
        { label: 'Empates', value: draws, display: `${draws} (${((draws / totalResultCount) * 100).toFixed(0)}%)`, badgeClass: 'bg-yellow-500/10 text-yellow-500', barClass: 'bg-yellow-500', valueClass: 'text-yellow-500' },
        { label: 'Derrotas', value: losses, display: `${losses} (${((losses / totalResultCount) * 100).toFixed(0)}%)`, badgeClass: 'bg-danger/10 text-danger', barClass: 'bg-danger', valueClass: 'text-danger' }
    ], 'Sin resultados definidos');

    // IMPORTANTE: este leaderboard reemplaza un gráfico redundante y enfatiza ranking + proporción relativa de goles.
    const sortedScorers = [...playerStats].filter(p => p.goals > 0).sort((a, b) => b.goals - a.goals).slice(0, 10);
    renderProgressRows('statsTopScorersLeaderboard', sortedScorers.map(p => ({
        label: p.name,
        value: p.goals,
        display: `${p.goals} goles`,
        badgeClass: 'bg-amber-500/10 text-amber-400',
        barClass: 'bg-amber-500',
        valueClass: 'text-amber-400'
    })), hasPlayers ? 'Sin goles registrados' : 'Sin jugadores registrados');

    // IMPORTANTE: disciplina se muestra como barras comparativas para evitar otro gráfico circular con la misma lectura.
    renderProgressRows('statsDisciplineBreakdown', [
        { label: 'Amarillas', value: yellow, display: `${yellow} tarjetas`, badgeClass: 'bg-yellow-500/10 text-yellow-500', barClass: 'bg-yellow-500', valueClass: 'text-yellow-500' },
        { label: 'Azules', value: blue, display: `${blue} tarjetas`, badgeClass: 'bg-blue-500/10 text-blue-400', barClass: 'bg-blue-500', valueClass: 'text-blue-400' },
        { label: 'Rojas', value: red, display: `${red} tarjetas`, badgeClass: 'bg-danger/10 text-danger', barClass: 'bg-danger', valueClass: 'text-danger' }
    ].filter(row => row.value > 0), 'Sin tarjetas registradas');

    safeText('statsFinancePaid', formatCOP(totalPaid));
    safeText('statsFinanceDebt', formatCOP(totalDebt));
    const financeTotal = totalPaid + totalDebt;
    const financePct = financeTotal > 0 ? (totalPaid / financeTotal) * 100 : 0;
    safeText('statsFinancePct', `${financePct.toFixed(0)}%`);
    setWidth('statsFinanceBar', financePct);

    const statsResultsCanvas = document.getElementById('statsResultsChart');
    if (statsResultsCanvas) {
        // IMPORTANTE: balance de resultados calcula distribución sobre partidos con resultado definido, no sobre partidos agendados.
        charts.results = new Chart(statsResultsCanvas, {
            type: 'doughnut',
            data: {
                labels: ['Victorias', 'Empates', 'Derrotas'],
                datasets: [{ data: [wins, draws, losses], backgroundColor: ['#10B981', '#F59E0B', '#EF4444'], borderWidth: 0 }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#94a3b8' } },
                    tooltip: { callbacks: { label: (ctx) => chartTooltipLabel(ctx, (label, value) => `${label}: ${value} partidos (${((value / totalResultCount) * 100).toFixed(0)}% del balance)`) } }
                }
            }
        });
    }

    const ctxAttendance = document.getElementById('statsAttendanceChart');
    if (ctxAttendance) {
        const sortedAttendance = [...playerStats].sort((a, b) => b.matches - a.matches).slice(0, 15);
        // IMPORTANTE: asistencia cuenta presencias por jugador usando presentPlayers o playerDetails cuando no hay lista explícita.
        charts.attendance = new Chart(ctxAttendance, {
            type: 'bar',
            data: {
                labels: sortedAttendance.map(p => p.name),
                datasets: [{ label: 'Partidos jugados', data: sortedAttendance.map(p => p.matches), backgroundColor: '#3B82F6', barThickness: 10, borderRadius: 6 }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: { x: { ticks: { color: '#94a3b8', font: { size: 10 } } }, y: { ticks: { color: '#94a3b8' } } },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => chartTooltipLabel(ctx, (_, value) => `${value} partidos asistidos`) } } }
            }
        });
    }

    const ctxGoalsPerMatch = document.getElementById('statsGoalsPerMatchChart');
    if (ctxGoalsPerMatch) {
        const sortedGoalsPerMatch = [...playerStats].filter(p => p.matches > 0).sort((a, b) => b.goalPerMatch - a.goalPerMatch).slice(0, 10);
        // IMPORTANTE: esta gráfica muestra eficiencia goleadora promedio, no solo volumen total de goles.
        charts.goalsPerMatch = new Chart(ctxGoalsPerMatch, {
            type: 'bar',
            indexAxis: 'y',
            data: {
                labels: sortedGoalsPerMatch.map(p => p.name),
                datasets: [{ label: 'Goles/P', data: sortedGoalsPerMatch.map(p => Number(p.goalPerMatch.toFixed(2))), backgroundColor: '#10B981', barThickness: 14, borderRadius: 8 }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => chartTooltipLabel(ctx, (_, value) => `${value.toFixed(2)} goles promedio por partido`) } } }
            }
        });
    }

    const ctxMvp = document.getElementById('statsMvpChart');
    if (ctxMvp) {
        const sortedMvp = [...playerStats].filter(p => p.matches > 0 || p.goals > 0).sort((a, b) => b.mvpScore - a.mvpScore).slice(0, 10);
        // IMPORTANTE: MVP usa fórmula configurable: goles*peso + PJ*peso + tarjetas*peso.
        charts.mvp = new Chart(ctxMvp, {
            type: 'bar',
            indexAxis: 'y',
            data: {
                labels: sortedMvp.map(p => p.name),
                datasets: [{ label: 'MVP', data: sortedMvp.map(p => Number(p.mvpScore.toFixed(1))), backgroundColor: '#A855F7', barThickness: 14, borderRadius: 8 }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => chartTooltipLabel(ctx, (_, value) => `${value.toFixed(1)} puntos MVP según fórmula activa`) } } }
            }
        });
    }

    let cumDiff = 0;
    const trendData = labels.map((_, i) => {
        const diff = (gf[i] || 0) - (gc[i] || 0);
        cumDiff += diff;
        return cumDiff;
    });

    const statsTrendCanvas = document.getElementById('statsGoalsTrendChart');
    if (statsTrendCanvas) {
        // IMPORTANTE: tendencia acumula diferencia de gol partido a partido para leer momentum colectivo.
        charts.goalsTrend = new Chart(statsTrendCanvas, {
            type: 'line',
            data: { labels, datasets: [{ label: 'Diferencia de Gol Acumulada', data: trendData, borderColor: '#F59E0B', tension: 0.35, fill: true, backgroundColor: 'rgba(245, 158, 11, 0.10)' }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => chartTooltipLabel(ctx, (_, value) => `${value > 0 ? '+' : ''}${value} goles de diferencia acumulada`) } } }
            }
        });
    }

    const dashboardTrendCanvas = document.getElementById('dashboardGoalsTrendChart');
    if (dashboardTrendCanvas) {
        // IMPORTANTE: el dashboard usa un canvas con ID único para no depender de normalización de IDs duplicados.
        charts.dashboardGoalsTrend = new Chart(dashboardTrendCanvas, {
            type: 'line',
            data: { labels, datasets: [{ label: 'DG acumulada', data: trendData, borderColor: '#F59E0B', tension: 0.35, fill: true, backgroundColor: 'rgba(245, 158, 11, 0.10)' }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: { x: { display: false }, y: { display: false } },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => chartTooltipLabel(ctx, (_, value) => `${value > 0 ? '+' : ''}${value} goles de diferencia acumulada`) } } }
            }
        });
    }
};

// --- TÁCTICA ---
const getTacticsType = () => ((tournamentData.name || "").includes("HIC") ? 5 : 6);
const getSavedLineups = () => Array.isArray(tournamentData.savedLineups) ? tournamentData.savedLineups : [];
const normalizeLineupMeta = (meta = {}) => ({ ...meta });
const getPlayerMeta = (playerId, fallbackRole = 'suplente') => {
    if (!playerId) return { role: fallbackRole, availability: 'disponible' };
    if (!currentLineupMeta[playerId]) {
        currentLineupMeta[playerId] = { role: fallbackRole, availability: 'disponible' };
    }
    currentLineupMeta[playerId].role ||= fallbackRole;
    currentLineupMeta[playerId].availability ||= 'disponible';
    return currentLineupMeta[playerId];
};
const getDefaultRoleForSlot = (index, top) => {
    if (index === 'gk') return 'arquero';
    if (top >= 70) return 'cierre';
    if (top <= 30) return 'pivote';
    return 'ala';
};
const roleOptions = (selected) => Object.entries(PLAYER_ROLES).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
const availabilityOptions = (selected) => Object.entries(AVAILABILITY_STATES).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
const buildLineupSnapshot = (name = '') => {
    const formSelect = document.getElementById('formationSelect');
    const type = getTacticsType();
    const formationIndex = Number(formSelect?.value || 0);
    return {
        id: selectedLineupId || crypto.randomUUID(),
        name: name || `Alineación ${getSavedLineups().length + 1}`,
        formationType: type,
        formationIndex,
        formationName: FORMATIONS[type][formationIndex]?.name || '',
        slots: structuredClone(currentLineup || {}),
        meta: structuredClone(currentLineupMeta || {}),
        updatedAt: new Date().toISOString()
    };
};

window.updateLineupSelectors = () => {
    const saved = getSavedLineups();
    const tacticsSelect = document.getElementById('savedLineupSelect');
    const matchSelect = document.getElementById('matchLineupSelect');

    [tacticsSelect, matchSelect].forEach((select) => {
        if (!select) return;
        const currentValue = select.value;
        const firstLabel = select.id === 'matchLineupSelect' ? 'Sin alineación rápida' : 'Alineaciones guardadas';
        select.innerHTML = `<option value="">${escapeHTML(firstLabel)}</option>`;
        saved.forEach((lineup) => {
            const option = document.createElement('option');
            option.value = lineup.id;
            option.textContent = `${lineup.name}${lineup.formationName ? ` · ${lineup.formationName}` : ''}`;
            select.appendChild(option);
        });
        select.value = saved.some(l => l.id === currentValue) ? currentValue : (select.id === 'savedLineupSelect' ? selectedLineupId : '');
    });
};

window.initTactics = () => {
    const type = getTacticsType();
    const is5v5 = type === 5;

    safeText('tacticsInfo', is5v5 ? "Modo: Futbol 5 (HIC)" : "Modo: Futbol 6 (Anillo Vial)");

    const select = document.getElementById('formationSelect');
    if (select) {
        const previous = select.value || 0;
        select.innerHTML = '';
        FORMATIONS[type].forEach((f, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = f.name;
            select.appendChild(opt);
        });
        select.value = FORMATIONS[type][previous] ? previous : 0;
    }

    const saved = getSavedLineups();
    const preferred = saved.find(l => l.id === selectedLineupId) || saved[0];
    currentLineup = structuredClone(preferred?.slots || tournamentData.savedLineup || {});
    currentLineupMeta = normalizeLineupMeta(structuredClone(preferred?.meta || tournamentData.savedLineupMeta || {}));
    selectedLineupId = preferred?.id || '';
    if (preferred?.formationType === type && select) select.value = preferred.formationIndex || 0;
    safeVal('lineupName', preferred?.name || '');

    window.updateLineupSelectors();
    window.renderFormation();
};

window.renderFormation = () => {
    const type = getTacticsType();
    const formSelect = document.getElementById('formationSelect');
    if (!formSelect) return;

    const formIndex = Number(formSelect.value || 0);
    const formation = FORMATIONS[type][formIndex] || FORMATIONS[type][0];
    const container = document.getElementById('pitchContainer');
    if (!container) return;

    const nodes = container.querySelectorAll('.player-node, .player-node-label, .player-node-meta');
    nodes.forEach(n => n.remove());

    // IMPORTANTE: el campo completo acepta drops y los redirige al slot táctico más cercano.
    container.ondragover = (e) => {
        e.preventDefault();
        container.classList.add('drag-over');
    };
    container.ondragleave = () => container.classList.remove('drag-over');
    container.ondrop = (e) => {
        e.preventDefault();
        container.classList.remove('drag-over');
        const payload = window.getDragPayload(e);
        if (!payload?.playerId) return;
        const rect = container.getBoundingClientRect();
        const left = ((e.clientX - rect.left) / rect.width) * 100;
        const top = ((e.clientY - rect.top) / rect.height) * 100;
        const slots = [{ index: 'gk', left: 50, top: 90 }, ...formation.pos.map((pos, i) => ({ index: i, left: pos[0], top: pos[1] }))];
        const nearest = slots.reduce((best, slot) => {
            const distance = Math.hypot(slot.left - left, slot.top - top);
            return !best || distance < best.distance ? { ...slot, distance } : best;
        }, null);
        if (nearest) window.assignPlayerToSlot(payload.playerId, nearest.index, payload.fromSlot);
    };

    window.createNode(container, 50, 90, 'gk', 'arquero');
    formation.pos.forEach((pos, i) => window.createNode(container, pos[0], pos[1], i, getDefaultRoleForSlot(i, pos[1])));
    window.renderBench();
};

window.getDragPayload = (event) => {
    try {
        return JSON.parse(event.dataTransfer.getData('application/json') || '{}');
    } catch (e) {
        return {};
    }
};

window.assignPlayerToSlot = (playerId, targetSlot, fromSlot = null) => {
    // IMPORTANTE: drag/drop conserva unicidad; si el destino está ocupado se intercambian jugadores.
    const previousTargetPlayer = currentLineup[targetSlot];
    Object.keys(currentLineup).forEach(slot => {
        if (String(currentLineup[slot]) === String(playerId)) delete currentLineup[slot];
    });
    currentLineup[targetSlot] = playerId;
    if (fromSlot !== null && fromSlot !== undefined && fromSlot !== '' && previousTargetPlayer) {
        currentLineup[fromSlot] = previousTargetPlayer;
    }
    selectedLineupId = '';
    window.renderFormation();
};

window.createNode = (container, left, top, index, defaultRole = 'ala') => {
    const playerId = currentLineup[index];
    const player = players.find(p => String(p.id) === String(playerId));

    const node = document.createElement('div');
    node.className = 'player-node';
    node.style.left = left + '%';
    node.style.top = top + '%';
    node.textContent = player ? player.number : (index === 'gk' ? 'GK' : '+');
    node.dataset.slot = index;
    node.draggable = Boolean(player);

    if (player) {
        const meta = getPlayerMeta(player.id, defaultRole);
        node.style.background = meta.availability === 'disponible' ? '#F59E0B' : (meta.availability === 'duda' ? '#38BDF8' : '#EF4444');
        node.style.color = '#09101D';
        node.style.border = '2px solid #fff';
        node.title = `${PLAYER_ROLES[meta.role]} · ${AVAILABILITY_STATES[meta.availability]}`;
    }

    node.onclick = () => window.openPlayerPick(index);
    node.ondragstart = (e) => {
        // IMPORTANTE: payload mínimo para mover jugadores sin depender del texto visible del nodo.
        if (!player) return e.preventDefault();
        node.classList.add('dragging');
        e.dataTransfer.setData('application/json', JSON.stringify({ playerId: player.id, fromSlot: index }));
    };
    node.ondragend = () => node.classList.remove('dragging');
    node.ondragover = (e) => {
        e.preventDefault();
        node.classList.add('drag-over');
    };
    node.ondragleave = () => node.classList.remove('drag-over');
    node.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        node.classList.remove('drag-over');
        const payload = window.getDragPayload(e);
        if (payload?.playerId) window.assignPlayerToSlot(payload.playerId, index, payload.fromSlot);
    };

    if (player) {
        const meta = getPlayerMeta(player.id, defaultRole);
        const label = document.createElement('div');
        label.className = 'player-node-label';
        label.textContent = player.name.split(' ')[0];
        label.style.left = left + '%';
        label.style.top = (top + 6) + '%';
        container.appendChild(label);

        const controls = document.createElement('div');
        controls.className = 'player-node-meta space-y-1';
        controls.style.left = left + '%';
        controls.style.top = `${Math.min(top + 10, 92)}%`;
        controls.innerHTML = `
            <select onchange="window.updateLineupPlayerMeta('${player.id}', 'role', this.value)">${roleOptions(meta.role)}</select>
            <select onchange="window.updateLineupPlayerMeta('${player.id}', 'availability', this.value)">${availabilityOptions(meta.availability)}</select>
        `;
        controls.onclick = (e) => e.stopPropagation();
        container.appendChild(controls);
    }

    container.appendChild(node);
};

window.updateLineupPlayerMeta = (playerId, key, value) => {
    currentLineupMeta[playerId] ||= { role: 'suplente', availability: 'disponible' };
    currentLineupMeta[playerId][key] = value;
    selectedLineupId = '';
    window.renderFormation();
};

window.openPlayerPick = (posIndex) => {
    activePosIndex = posIndex;
    const list = document.getElementById('playerPickList');
    if (!list) return;

    list.innerHTML = '<button onclick="window.selectPlayerForPos(null)" class="w-full text-left p-3 hover:bg-white/5 rounded-2xl text-slate-400 text-xs border border-white/5">--- Vacío ---</button>';

    const usedIds = Object.values(currentLineup);
    players.forEach(p => {
        if (!usedIds.includes(p.id) || currentLineup[activePosIndex] === p.id) {
            const btn = document.createElement('button');
            btn.className = 'w-full text-left p-3 hover:bg-white/5 rounded-2xl text-white text-sm border border-white/5';
            const meta = getPlayerMeta(p.id, activePosIndex === 'gk' ? 'arquero' : 'suplente');
            btn.innerHTML = `<b>${escapeHTML(p.number)}</b> ${escapeHTML(p.name)}<span class="block text-[10px] text-slate-400 mt-1">${escapeHTML(PLAYER_ROLES[meta.role])} · ${escapeHTML(AVAILABILITY_STATES[meta.availability])}</span>`;
            btn.onclick = () => window.selectPlayerForPos(p.id);
            list.appendChild(btn);
        }
    });

    document.getElementById('playerPickModal')?.classList.remove('hidden');
};

window.selectPlayerForPos = (pid) => {
    if (pid) currentLineup[activePosIndex] = pid;
    else delete currentLineup[activePosIndex];

    selectedLineupId = '';
    window.closeModal('playerPickModal');
    window.renderFormation();
};

window.renderBench = () => {
    const benchDiv = document.getElementById('benchList');
    if (!benchDiv) return;

    benchDiv.innerHTML = '';

    const usedIds = Object.values(currentLineup);
    const bench = players.filter(p => !usedIds.includes(p.id));

    if (bench.length === 0) {
        benchDiv.innerHTML = '<span class="text-xs text-slate-500">Todos convocados</span>';
        return;
    }

    bench.forEach(p => {
        const meta = getPlayerMeta(p.id, 'suplente');
        const tag = document.createElement('div');
        tag.className = 'bench-player-tag text-xs bg-white/5 px-3 py-2 rounded-2xl text-slate-300 border border-white/8 min-w-[210px]';
        tag.draggable = true;
        tag.innerHTML = `
            <div class="font-bold text-white">${escapeHTML(p.number)}. ${escapeHTML(p.name)}</div>
            <div class="grid grid-cols-2 gap-2 mt-2">
                <select class="premium-select px-2 py-1 text-[10px]" onchange="window.updateLineupPlayerMeta('${p.id}', 'role', this.value)">${roleOptions(meta.role)}</select>
                <select class="premium-select px-2 py-1 text-[10px]" onchange="window.updateLineupPlayerMeta('${p.id}', 'availability', this.value)">${availabilityOptions(meta.availability)}</select>
            </div>
        `;
        tag.ondragstart = (e) => {
            // IMPORTANTE: los suplentes también se arrastran al campo para armar la convocatoria visualmente.
            tag.classList.add('dragging');
            e.dataTransfer.setData('application/json', JSON.stringify({ playerId: p.id, fromSlot: null }));
        };
        tag.ondragend = () => tag.classList.remove('dragging');
        benchDiv.appendChild(tag);
    });
};

window.loadSavedLineup = (lineupId) => {
    const lineup = getSavedLineups().find(l => l.id === lineupId);
    if (!lineup) return;
    selectedLineupId = lineup.id;
    currentLineup = structuredClone(lineup.slots || {});
    currentLineupMeta = normalizeLineupMeta(structuredClone(lineup.meta || {}));
    const formSelect = document.getElementById('formationSelect');
    if (formSelect && lineup.formationType === getTacticsType()) formSelect.value = lineup.formationIndex || 0;
    safeVal('lineupName', lineup.name || '');
    window.updateLineupSelectors();
    window.renderFormation();
};

window.saveLineup = async () => {
    try {
        // IMPORTANTE: persistencia multi-alineación; guarda snapshot, roles y disponibilidad sin perder el formato legado.
        const name = document.getElementById('lineupName')?.value.trim() || '';
        const snapshot = buildLineupSnapshot(name);
        snapshot.createdAt = getSavedLineups().find(l => l.id === snapshot.id)?.createdAt || snapshot.updatedAt;
        const savedLineups = getSavedLineups().filter(l => l.id !== snapshot.id);
        savedLineups.push(snapshot);
        await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), {
            savedLineup: snapshot.slots,
            savedLineupMeta: snapshot.meta,
            savedLineups
        });
        tournamentData.savedLineup = snapshot.slots;
        tournamentData.savedLineupMeta = snapshot.meta;
        tournamentData.savedLineups = savedLineups;
        selectedLineupId = snapshot.id;
        safeVal('lineupName', snapshot.name);
        window.updateLineupSelectors();
        window.showToast("Alineación guardada");
    } catch (e) {
        console.error(e);
        window.showToast("Error al guardar alineación", true);
    }
};

window.applyLineupToMatch = (lineupId) => {
    const lineup = getSavedLineups().find(l => l.id === lineupId);
    if (!lineup) return;
    // IMPORTANTE: sincronización con partidos; solo convoca jugadores disponibles o en duda para evitar lesionados/ausentes por accidente.
    const selectedIds = Object.values(lineup.slots || {}).filter(Boolean);
    Object.values(matchSelection).forEach(state => { state.selected = false; });
    selectedIds.forEach(pid => {
        const meta = lineup.meta?.[pid] || { availability: 'disponible' };
        if (['lesionado', 'ausente'].includes(meta.availability)) return;
        if (!matchSelection[pid]) {
            matchSelection[pid] = { selected: false, paidRef: false, refPaidAmount: 0, finesPaidAmount: 0, stats: { goals: 0, yellow: 0, blue: 0, red: 0 } };
        }
        matchSelection[pid].selected = true;
    });
    safeText('matchLineupHint', `${lineup.name}: ${selectedIds.length} jugadores revisados según disponibilidad.`);
    window.renderMatchSelector();
};

// --- RENDER GLOBAL ---
const getMatchLabel = (matchId) => {
    const match = (tournamentData.matches || []).find(m => String(m.id) === String(matchId));
    if (!match) return 'Sin partido';

    // IMPORTANTE: la etiqueta usa rival, jornada/fase y marcador cuando los datos nuevos estén disponibles.
    const dateLabel = new Date(match.date).toLocaleDateString();
    const opponent = match.opponent ? ` vs ${match.opponent}` : '';
    const round = match.round ? ` · ${match.round}` : '';
    const phase = match.phase ? ` · ${match.phase}` : '';
    return `${dateLabel}${opponent}${round}${phase} - ${match.goalsScored ?? 0}-${match.goalsConceded ?? 0}`;
};

const calculateFinancialSummary = () => {
    const matches = tournamentData.matches || [];
    const inscriptionExpected = players.length * (tournamentData.inscriptionPerPlayer || 0);
    const inscriptionCollected = players.reduce((sum, player) => sum + getPlayerTotalPaidFromHistory(player), 0);
    let finesExpected = 0;
    let finesCollected = 0;
    let refereeExpected = 0;
    let refereeCollected = 0;

    matches.forEach(match => {
        const details = match.playerDetails || {};
        const payments = match.refereePayments || {};
        const present = match.presentPlayers || [];
        const perPlayerRef = present.length > 0 ? (match.refereeValue || 0) / present.length : 0;

        present.forEach(playerId => {
            const playerFine = calculateMatchFine(details[playerId] || {});
            finesExpected += playerFine;
            finesCollected += Math.min(playerFine, getFinePaidFromHistory(playerId, match.id, payments[playerId]?.finesPaidAmount));

            refereeExpected += perPlayerRef;
            refereeCollected += Math.min(perPlayerRef, getRefereePaidFromHistory(playerId, match.id, payments[playerId]?.refPaidAmount));
        });
    });

    const historicalFineCredits = players.reduce((sum, player) => sum + Math.max(0, parseFloat(player.finesCredit) || 0), 0);
    const totalExpected = inscriptionExpected + finesExpected + refereeExpected;
    const totalCollected = inscriptionCollected + finesCollected + refereeCollected + historicalFineCredits;

    // IMPORTANTE: pendiente = esperado - cobrado, separado por rubro para no mezclar saldos derivados antiguos.
    return {
        inscriptionExpected,
        inscriptionCollected,
        inscriptionPending: Math.max(0, inscriptionExpected - inscriptionCollected),
        finesExpected,
        finesCollected: finesCollected + historicalFineCredits,
        finesPending: Math.max(0, finesExpected - finesCollected - historicalFineCredits),
        refereeExpected,
        refereeCollected,
        refereePending: Math.max(0, refereeExpected - refereeCollected),
        totalExpected,
        totalCollected,
        totalPending: Math.max(0, totalExpected - totalCollected)
    };
};

window.renderAll = () => {
    window.renderPlayers();
    window.renderMatchSelector();
    window.renderMatchesList();
    window.renderPaymentMatchSelect();
    window.updateLineupSelectors();
    window.renderFinances();
    window.renderDashboard();
    window.renderStatsTable();
    window.updatePaymentTypeUI();
    window.renderStatsCharts();
};

window.renderPaymentMatchSelect = () => {
    const matchSelect = document.getElementById('payMatchSelect');
    if (!matchSelect) return;

    const matches = tournamentData.matches || [];
    matchSelect.innerHTML = '<option value="">Sin partido</option>';

    matches.forEach((m) => {
        const option = document.createElement('option');
        option.value = m.id;
        option.textContent = getMatchLabel(m.id);
        matchSelect.appendChild(option);
    });
};

window.updatePaymentTypeUI = () => {
    const typeSelect = document.getElementById('payTypeSelect');
    const matchSelect = document.getElementById('payMatchSelect');
    if (!typeSelect || !matchSelect) return;

    const type = typeSelect.value;
    const requiresMatch = type === 'arbitraje';

    matchSelect.disabled = type === 'inscripcion';
    matchSelect.classList.toggle('opacity-60', matchSelect.disabled);
    matchSelect.title = matchSelect.disabled ? 'No aplica para inscripción' : '';

    if (type === 'inscripcion') {
        matchSelect.value = '';
    }

    if (requiresMatch && !matchSelect.value && matchSelect.options.length > 1) {
        matchSelect.selectedIndex = 1;
    }
};

window.renderPlayers = () => {
    const input = document.getElementById('searchPlayer');
    const filter = (input?.value || '').toLowerCase();

    const grid = document.getElementById('playersGrid');
    const sel = document.getElementById('payPlayerSelect');
    if (grid) grid.innerHTML = '';
    if (sel) sel.innerHTML = '<option value="">Seleccionar Jugador...</option>';

    players.forEach(p => {
        const matchFilter = p.name.toLowerCase().includes(filter) || (p.number + '').includes(filter);

        if (matchFilter && grid) {
            const debt = Math.max(0, p.cardDebt || 0);
            const cardDebtHtml = debt > 0
                ? `<div class="text-xs text-danger font-bold mt-2">Multas: ${formatCOP(debt)}</div>`
                : '<div class="text-xs text-emerald-400 font-medium mt-2">Sin deuda de multas</div>';

            const card = document.createElement('div');
            card.className = 'glass rounded-[26px] p-5 border border-white/8 hover:border-white/15 transition group relative overflow-hidden';
            card.innerHTML = `
                <div class="absolute top-0 right-0 w-28 h-28 bg-gradient-to-br from-amber-500/10 to-transparent rounded-full blur-2xl"></div>
                <div class="relative z-10 flex justify-between items-start gap-3">
                    <div class="flex items-center gap-4 min-w-0">
                        <div class="w-12 h-12 rounded-2xl bg-white/5 border border-white/8 flex items-center justify-center font-extrabold text-slate-200 shrink-0">
                            ${escapeHTML(p.number)}
                        </div>
                        <div class="min-w-0">
                            <div class="font-extrabold text-white leading-tight truncate">${escapeHTML(p.name)}</div>
                            <div class="text-xs text-slate-500 mt-1">Abonado: ${formatCOP(getPlayerTotalPaidFromHistory(p))}</div>
                            ${cardDebtHtml}
                        </div>
                    </div>

                    <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition shrink-0">
                        <button onclick="window.openPlayerModal('${p.id}')" class="text-slate-500 hover:text-primary">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button onclick="window.deletePlayer('${p.id}')" class="text-slate-500 hover:text-danger">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        }

        if (sel) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.number}. ${p.name}`;
            sel.appendChild(opt);
        }
    });
};

window.renderMatchesList = () => {
    const list = document.getElementById('fullMatchesList');
    const recentList = document.getElementById('recentMatchesList');

    if (list) list.innerHTML = '';
    if (recentList) recentList.innerHTML = '';

    const matches = (tournamentData.matches || []).slice().reverse();
    safeText('totalMatchesCount', `${matches.length} partidos`);

    if (matches.length === 0) {
        if (list) list.innerHTML = '<div class="text-center text-slate-500 py-8">No hay partidos registrados</div>';
        return;
    }

    matches.forEach(m => {
        const item = document.createElement('div');
        item.className = 'glass p-4 rounded-[24px] border-l-4 border-white/10 flex justify-between items-center gap-3';

        if (m.result === 'Victoria') item.classList.add('border-l-success');
        else if (m.result === 'Derrota') item.classList.add('border-l-danger');
        else item.classList.add('border-l-primary');

        // IMPORTANTE: los metadatos nuevos hacen que el historial identifique rival, jornada, sede, fase y MVP.
        const opponentLabel = m.opponent ? `vs ${escapeHTML(m.opponent)}` : 'Rival sin registrar';
        const contextParts = [m.round, m.phase, m.venue].filter(Boolean).map(escapeHTML);
        const mvpLabel = m.mvpPlayerId ? `MVP: ${escapeHTML(getPlayerName(m.mvpPlayerId))}` : '';

        item.innerHTML = `
            <div class="cursor-pointer flex-1 min-w-0" onclick="window.viewMatchDetails('${m.id}')">
                <div class="text-xs text-slate-500 mb-1">${new Date(m.date).toLocaleDateString()}</div>
                <div class="text-sm font-bold text-slate-200 mb-1 truncate">${opponentLabel}</div>
                <div class="text-2xl font-extrabold text-white">
                    <span class="${m.result === 'Victoria' ? 'text-success' : ''}">${m.goalsScored}</span>
                    <span class="text-slate-500 mx-1">-</span>
                    <span class="${m.result === 'Derrota' ? 'text-danger' : ''}">${m.goalsConceded}</span>
                </div>
                <div class="text-xs font-bold uppercase text-slate-400 mt-1">${escapeHTML(m.result)}</div>
                <div class="text-[11px] text-slate-500 mt-2 truncate">${contextParts.join(' · ') || 'Sin jornada/sede/fase'}</div>
                ${mvpLabel ? `<div class="text-[11px] text-purple-300 mt-1">${mvpLabel}</div>` : ''}
            </div>

            <div class="flex gap-2 items-center shrink-0">
                <button onclick="window.viewMatchDetails('${m.id}')" class="bg-white/5 hover:bg-white/10 text-slate-300 w-10 h-10 rounded-full transition border border-white/8">
                    <i class="fa-solid fa-eye"></i>
                </button>
                <button onclick="window.editMatch('${m.id}')" class="bg-white/5 hover:bg-primary hover:text-ink text-white w-10 h-10 rounded-full transition border border-white/8">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button onclick="window.deleteMatch('${m.id}')" class="bg-white/5 hover:bg-danger text-white w-10 h-10 rounded-full transition border border-white/8">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;

        if (list) list.appendChild(item);

        if (recentList && recentList.children.length < 5) {
            const miniItem = document.createElement('div');
            miniItem.className = 'flex items-center justify-between gap-3 py-3 border-b border-white/6';
            miniItem.innerHTML = `
                <div class="cursor-pointer min-w-0" onclick="window.viewMatchDetails('${m.id}')">
                    <div class="text-xs text-slate-500">${new Date(m.date).toLocaleDateString()}</div>
                    <div class="text-[11px] font-bold text-slate-300 truncate">${escapeHTML(m.opponent ? `vs ${m.opponent}` : 'Rival sin registrar')}</div>
                    <div class="text-lg font-extrabold text-white">
                        <span class="${m.result === 'Victoria' ? 'text-success' : ''}">${m.goalsScored}</span>
                        <span class="text-slate-500 mx-1">-</span>
                        <span class="${m.result === 'Derrota' ? 'text-danger' : ''}">${m.goalsConceded}</span>
                    </div>
                </div>
                <div class="text-[10px] uppercase font-bold ${m.result === 'Victoria' ? 'text-success' : (m.result === 'Derrota' ? 'text-danger' : 'text-primary')}">
                    ${escapeHTML(m.result)}
                </div>
            `;
            recentList.appendChild(miniItem);
        }
    });
};

// IMPORTANTE: el selector MVP solo ofrece jugadores convocados para evitar datos inconsistentes.
window.renderMatchMvpSelect = () => {
    const select = document.getElementById('matchMvp');
    if (!select) return;

    const currentValue = select.value;
    const selectedIds = Object.keys(matchSelection).filter(id => matchSelection[id] && matchSelection[id].selected);
    select.innerHTML = '<option value="">Sin MVP</option>';

    selectedIds.forEach(pid => {
        const player = players.find(p => String(p.id) === String(pid));
        if (!player) return;
        const option = document.createElement('option');
        option.value = pid;
        option.textContent = player.name;
        select.appendChild(option);
    });

    if (selectedIds.includes(currentValue)) select.value = currentValue;
};

window.renderMatchSelector = () => {
    const grid = document.getElementById('matchPlayersGrid');
    if (!grid) return;

    grid.innerHTML = '';

    players.forEach(p => {
        if (!matchSelection[p.id]) {
            matchSelection[p.id] = {
                selected: false,
                paidRef: false,
                refPaidAmount: 0,
                finesPaidAmount: 0,
                stats: { goals: 0, yellow: 0, blue: 0, red: 0 }
            };
        }

        const state = matchSelection[p.id];
        if (!state.stats) state.stats = { goals: 0, yellow: 0, blue: 0, red: 0 };

        if (state.refPaidAmount === undefined) {
            state.refPaidAmount = state.paidRef ? null : 0;
        }

        if (state.finesPaidAmount === undefined || state.finesPaidAmount === null) {
            const legacyFine = state.paidFines ? calculateMatchFine(state.stats) : 0;
            state.finesPaidAmount = legacyFine;
            if ('paidFines' in state) delete state.paidFines;
        }

        const fineAmount = calculateMatchFine(state.stats);
        const finePaid = Math.min(parseFloat(state.finesPaidAmount) || 0, fineAmount);
        const hasDebt = fineAmount > 0 || finePaid > 0;

        const div = document.createElement('div');
        div.className = `p-4 rounded-[22px] border cursor-pointer transition flex flex-col relative ${
            state.selected
                ? 'bg-blue-900/15 border-secondary'
                : 'bg-white/[.03] border-white/6 hover:bg-white/[.05]'
        }`;

        div.onclick = (e) => {
            if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I' && e.target.tagName !== 'INPUT') {
                window.toggleMatchSelection(p.id);
            }
        };

        let content = `
            <div class="flex justify-between items-center mb-2">
                <span class="text-sm font-bold text-slate-200">${escapeHTML(p.number)}. ${escapeHTML(p.name)}</span>
                ${state.selected
                    ? '<i class="fa-solid fa-circle-check text-success"></i>'
                    : '<i class="fa-regular fa-circle text-slate-600"></i>'
                }
            </div>
        `;

        if (state.selected) {
            content += `
                <button onclick="window.toggleMatchPayRef('${p.id}')" class="w-full text-[10px] px-3 py-2 mb-2 rounded-xl border ${
                    state.paidRef
                        ? 'bg-success text-white border-success'
                        : 'bg-transparent text-slate-400 border-white/10'
                }">
                    Arbitraje: ${state.paidRef ? 'PAGADO' : 'PEND'}
                </button>
            `;

            if (hasDebt) {
                const fineStatus = fineAmount > 0 && finePaid >= fineAmount ? 'OK' : 'PEND';
                content += `
                    <div class="mt-1 rounded-2xl border ${finePaid > 0 ? 'border-warning/30' : 'border-danger/30'} p-3 bg-black/20">
                        <div class="flex items-center justify-between text-[10px] font-bold">
                            <span class="text-danger">Multa del partido: ${formatCOP(fineAmount)}</span>
                            <span class="${fineStatus === 'OK' ? 'text-success' : 'text-danger'}">${fineStatus}</span>
                        </div>
                        <div class="flex items-center gap-2 mt-2">
                            <input type="number" min="0" class="w-full bg-white/5 border border-white/8 rounded-xl text-center text-white text-[10px] py-2" placeholder="Monto pagado" value="${state.finesPaidAmount || ''}" oninput="window.updateMatchFinePayment('${p.id}', this.value)" onblur="window.renderMatchSelector()">
                            <button onclick="window.setMatchFineFull('${p.id}')" class="text-[10px] px-3 py-2 rounded-xl bg-warning text-ink font-bold">Total</button>
                        </div>
                        <div class="text-[10px] text-slate-400 mt-2">Pagado: ${formatCOP(finePaid)}</div>
                    </div>
                `;
            }

            const historicalDebt = Math.max(0, p.cardDebt || 0);
            const historicalPaid = Math.max(0, p.finesCredit || 0);
            const showHistoricalBlock = historicalDebt > 0 || historicalPaid > 0;

            if (showHistoricalBlock) {
                const historicalStatus = historicalDebt > 0 ? 'PEND' : 'PAGADO';
                content += `
                    <div class="mt-3 rounded-2xl border ${historicalDebt > 0 ? 'border-danger/30' : 'border-success/30'} p-3 bg-black/20">
                        <div class="flex items-center justify-between text-[10px] font-bold">
                            <span class="text-danger">Deuda histórica: ${formatCOP(historicalDebt)}</span>
                            <span class="${historicalDebt > 0 ? 'text-danger' : 'text-success'}">${historicalStatus}</span>
                        </div>
                        <div class="flex items-center gap-2 mt-2">
                            <input type="number" min="0" class="w-full bg-white/5 border border-white/8 rounded-xl text-center text-white text-[10px] py-2" placeholder="Monto pago" ${historicalDebt > 0 ? '' : 'disabled'} id="historicDebt-${p.id}">
                            <button onclick="window.registerHistoricalCardPayment('${p.id}')" class="text-[10px] px-3 py-2 rounded-xl bg-warning text-ink font-bold" ${historicalDebt > 0 ? '' : 'disabled'}>Abonar</button>
                            <button onclick="window.registerHistoricalCardPayment('${p.id}', true)" class="text-[10px] px-3 py-2 rounded-xl bg-success text-white font-bold" ${historicalDebt > 0 ? '' : 'disabled'}>Total</button>
                        </div>
                    </div>
                `;
            }

            const s = state.stats;
            if (s && (s.goals > 0 || s.yellow > 0 || s.blue > 0 || s.red > 0)) {
                content += `
                    <div class="mt-3 pt-2 border-t border-white/6 flex gap-2 text-[11px] justify-center">
                        ${s.goals > 0 ? `<span class="text-success">⚽${s.goals}</span>` : ''}
                        ${s.yellow > 0 ? `<span class="text-yellow-500">🟨${s.yellow}</span>` : ''}
                        ${s.blue > 0 ? `<span class="text-blue-400">🟦${s.blue}</span>` : ''}
                        ${s.red > 0 ? `<span class="text-red-500">🟥${s.red}</span>` : ''}
                    </div>
                `;
            }
        }

        div.innerHTML = content;
        grid.appendChild(div);
    });

    window.renderMatchMvpSelect();
    window.calcRef();
};

window.renderFinances = () => {
    const tbody = document.getElementById('financesTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    const statusFilter = document.getElementById('financeStatusFilter')?.value || 'todos';
    let renderedCount = 0;
    const cost = tournamentData.inscriptionPerPlayer || 0;
    const summary = calculateFinancialSummary();

    safeText('financeExpectedTotal', formatCOP(summary.totalExpected));
    safeText('financeCollectedTotal', formatCOP(summary.totalCollected));
    safeText('financePendingTotal', formatCOP(summary.totalPending));
    safeText('financeFinesCollected', formatCOP(summary.finesCollected));
    safeText('financeRefPending', formatCOP(summary.refereePending));

    players.forEach(p => {
        // IMPORTANTE: el abonado de inscripción se recalcula desde historial para no depender de totalPaid si quedó desactualizado.
        const paid = getPlayerTotalPaidFromHistory(p);
        const debt = cost - paid;
        const finesDebt = calculatePlayerDebts(tournamentData.matches || [])[p.id] ?? Math.max(0, p.cardDebt || 0);
        const totalDebt = Math.max(0, debt) + finesDebt;
        const isUpToDate = totalDebt <= 0;

        if (statusFilter === 'al-dia' && !isUpToDate) return;
        if (statusFilter === 'pendiente' && isUpToDate) return;

        const status = totalDebt <= 0
            ? '<span class="text-success text-xs bg-green-900/20 border border-green-500/20 px-3 py-1 rounded-full">Al día</span>'
            : '<span class="text-warning text-xs bg-yellow-900/20 border border-yellow-500/20 px-3 py-1 rounded-full">Pendiente</span>';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="py-4 pl-2 font-medium text-white">${escapeHTML(p.name)}</td>
            <td class="py-4 text-right text-slate-400">${formatCOP(cost)}</td>
            <td class="py-4 text-right text-success">${formatCOP(paid)}</td>
            <td class="py-4 text-right ${debt > 0 ? 'text-danger font-bold' : 'text-slate-500'}">${formatCOP(Math.max(0, debt))}</td>
            <td class="py-4 text-right text-danger font-bold">${finesDebt > 0 ? formatCOP(finesDebt) : '-'}</td>
            <td class="py-4 text-right font-bold text-white">${formatCOP(totalDebt)}</td>
            <td class="py-4 text-center">${status}</td>
            <td class="py-4 text-center">
                <button onclick="window.openPaymentHistory('${p.id}')" class="text-xs bg-white/5 hover:bg-secondary text-white px-3 py-2 rounded-xl transition border border-white/8">
                    Ver
                </button>
            </td>
        `;

        tbody.appendChild(tr);
        renderedCount++;
    });

    const financesCount = document.getElementById('financesCount');
    if (financesCount) financesCount.textContent = `${renderedCount} jugadores`;
};

window.exportPlayersCSV = () => {
    const rows = players.map(player => ({
        id: player.id,
        numero: player.number || '',
        jugador: player.name || '',
        costo_inscripcion: tournamentData.inscriptionPerPlayer || 0,
        abonado_inscripcion: getPlayerTotalPaidFromHistory(player),
        deuda_multas: calculatePlayerDebts(tournamentData.matches || [])[player.id] || 0,
        pagos_registrados: (player.payments || []).length
    }));
    downloadCSV(`jugadores-${currentTournament || 'torneo'}.csv`, rows);
};

window.exportPaymentsCSV = () => {
    const rows = players.flatMap(player => (player.payments || []).map(payment => ({
        id_pago: payment.id || '',
        fecha: payment.date || '',
        jugador: player.name || '',
        jugador_id: player.id,
        tipo: PAYMENT_TYPE_LABELS[payment.type || 'inscripcion'] || 'Inscripción',
        monto: getPaymentAmount(payment),
        partido: payment.matchId ? getMatchLabel(payment.matchId) : '',
        partido_id: payment.matchId || '',
        usuario_origen: payment.origin || payment.createdBy || payment.user || 'sin origen'
    }))).sort((a, b) => new Date(a.fecha || 0) - new Date(b.fecha || 0));
    downloadCSV(`pagos-${currentTournament || 'torneo'}.csv`, rows);
};

window.exportDebtsCSV = () => {
    const debts = calculatePlayerDebts(tournamentData.matches || []);
    const cost = tournamentData.inscriptionPerPlayer || 0;
    const rows = players.map(player => {
        const paid = getPlayerTotalPaidFromHistory(player);
        const inscriptionDebt = Math.max(0, cost - paid);
        const finesDebt = debts[player.id] || 0;
        return {
            jugador_id: player.id,
            jugador: player.name || '',
            deuda_inscripcion: inscriptionDebt,
            deuda_multas: finesDebt,
            deuda_total: inscriptionDebt + finesDebt
        };
    });
    downloadCSV(`deudas-${currentTournament || 'torneo'}.csv`, rows);
};

window.renderDashboard = () => {
    const matches = tournamentData.matches || [];
    const advanced = calculateAdvancedMetrics(matches);
    const totalPaid = players.reduce((acc, p) => acc + getPlayerTotalPaidFromHistory(p), 0);
    const totalDebt = Math.max(0, (players.length * (tournamentData.inscriptionPerPlayer || 0)) - totalPaid);
    const debtsFromHistory = calculatePlayerDebts(matches);
    const totalFinesDebt = players.reduce((acc, p) => acc + Math.max(0, (debtsFromHistory[p.id] ?? p.cardDebt) || 0), 0);
    const totalPayments = players.reduce((acc, p) => acc + ((p.payments || []).length), 0);

    const { teamStats, playerList, totalGF, totalGC, diff } = advanced;
    setHidden('dashboardMatchesEmpty', matches.length > 0);
    setHidden('dashboardPlayersEmpty', players.length > 0);
    setHidden('dashboardPaymentsEmpty', totalPayments > 0);
    const avgGF = advanced.avgGF.toFixed(1);
    const avgGC = advanced.avgGC.toFixed(1);
    const avgCards = advanced.avgCards.toFixed(1);

    // IMPORTANTE: las tarjetas por jugador se calculan desde playerDetails para detectar al jugador con mayor promedio.
    const badBoy = [...playerList]
        .sort((a, b) => b.cards - a.cards || b.cardsPerMatch - a.cardsPerMatch)[0] || { name: '-', cardsPerMatch: 0 };
    const goalsPerMatchLeader = [...playerList]
        .filter(p => p.matches > 0)
        .sort((a, b) => b.goalPerMatch - a.goalPerMatch)[0] || { name: '-', goalPerMatch: 0 };
    const goalShareLeader = [...playerList]
        .filter(p => p.goals > 0)
        .sort((a, b) => b.goalParticipation - a.goalParticipation)[0] || { name: '-', goalParticipation: 0 };
    const cardsPerMatchLeader = [...playerList]
        .filter(p => p.matches > 0)
        .sort((a, b) => b.cardsPerMatch - a.cardsPerMatch)[0] || { name: '-', cardsPerMatch: 0 };
    const mvpLeader = [...playerList]
        .filter(p => p.matches > 0 || p.goals > 0)
        .sort((a, b) => b.mvpScore - a.mvpScore)[0] || { name: '-', mvpScore: 0 };
    const formula = advanced.formula;

    safeText('dashCollected', formatCOP(totalPaid));
    safeText('dashDebt', formatCOP(totalDebt + totalFinesDebt));
    safeText('dashAvgGF', avgGF);
    safeText('dashAvgGC', avgGC);
    safeText('dashAvgCards', avgCards);
    safeText('dashBadBoyName', badBoy.name);
    safeText('dashBadBoyAvg', badBoy.cardsPerMatch.toFixed(1));
    safeText('dashWinPct', `${advanced.winPercentage.toFixed(0)}%`);
    safeText('dashPPG', advanced.pointsPerMatch.toFixed(2));
    safeText('dashAvgGoalDiff', formatSignedDecimal(advanced.avgGoalDiff, 1));
    safeText('dashMvpName', mvpLeader.name);
    safeText('dashMvpScore', mvpLeader.mvpScore.toFixed(1));
    safeText('dashMvpFormula', `G*${formula.goals} + PJ*${formula.matches} + T*${formula.cards}`);
    safeText('dashGoalsPerMatchLeader', goalsPerMatchLeader.name);
    safeText('dashGoalsPerMatchValue', goalsPerMatchLeader.goalPerMatch.toFixed(2));
    safeText('dashGoalShareLeader', goalShareLeader.name);
    safeText('dashGoalShareValue', `${goalShareLeader.goalParticipation.toFixed(0)}%`);
    safeText('dashCardsPerMatchLeader', cardsPerMatchLeader.name);
    safeText('dashCardsPerMatchValue', cardsPerMatchLeader.cardsPerMatch.toFixed(2));
    const financeTarget = totalPaid + totalDebt + totalFinesDebt;
    const collectionPct = financeTarget > 0 ? (totalPaid / financeTarget) * 100 : 0;
    safeText('dashCollectionPct', `${collectionPct.toFixed(0)}%`);
    safeText('dashboardFinanceSummary', `${formatCOP(totalPaid)} recaudado de ${formatCOP(financeTarget)} proyectados`);
    setWidth('dashCollectionBar', collectionPct);

    // IMPORTANTE: estas cards reemplazan el doughnut duplicado y muestran conteos + porcentaje contextual del balance.
    const totalResultCount = Math.max(teamStats.pj, 1);
    renderProgressRows('dashboardResultCards', [
        { label: 'Victorias', value: teamStats.pg, display: `${teamStats.pg} · ${((teamStats.pg / totalResultCount) * 100).toFixed(0)}%`, badgeClass: 'bg-success/10 text-success', barClass: 'bg-success', valueClass: 'text-success' },
        { label: 'Empates', value: teamStats.pe, display: `${teamStats.pe} · ${((teamStats.pe / totalResultCount) * 100).toFixed(0)}%`, badgeClass: 'bg-yellow-500/10 text-yellow-500', barClass: 'bg-yellow-500', valueClass: 'text-yellow-500' },
        { label: 'Derrotas', value: teamStats.pp, display: `${teamStats.pp} · ${((teamStats.pp / totalResultCount) * 100).toFixed(0)}%`, badgeClass: 'bg-danger/10 text-danger', barClass: 'bg-danger', valueClass: 'text-danger' }
    ], 'Sin resultados definidos');

    const statsTable = document.getElementById('teamStatsTableBody');
    if (statsTable) {
        const diffClass = diff > 0 ? 'text-success' : (diff < 0 ? 'text-danger' : 'text-slate-400');
        const tName = tournamentData.name || "CONSTRU-SANTAMARIA";

        // IMPORTANTE: se agregan %V, PPG y DG/P como KPIs derivados del historial de partidos.
        statsTable.innerHTML = `
            <tr class="hover:bg-white/[.03] transition">
                <td class="stat-cell text-left pl-4 font-extrabold text-white">${escapeHTML(tName)}</td>
                <td class="stat-cell font-mono">${teamStats.pj}</td>
                <td class="stat-cell text-success font-bold">${teamStats.pg}</td>
                <td class="stat-cell text-yellow-500 font-bold">${teamStats.pe}</td>
                <td class="stat-cell text-red-500 font-bold">${teamStats.pp}</td>
                <td class="stat-cell text-slate-400">${totalGF}</td>
                <td class="stat-cell text-slate-400">${totalGC}</td>
                <td class="stat-cell ${diffClass} font-bold">${diff > 0 ? '+' + diff : diff}</td>
                <td class="stat-cell text-success font-bold">${advanced.winPercentage.toFixed(0)}%</td>
                <td class="stat-cell text-primary font-bold">${advanced.pointsPerMatch.toFixed(2)}</td>
                <td class="stat-cell ${diffClass} font-bold">${formatSignedDecimal(advanced.avgGoalDiff, 1)}</td>
                <td class="stat-cell text-primary font-extrabold text-lg">${teamStats.pts}</td>
            </tr>
        `;

        const totalPlayed = teamStats.pj || 1;
        document.getElementById('barWins').style.width = ((teamStats.pg / totalPlayed) * 100) + '%';
        document.getElementById('barDraws').style.width = ((teamStats.pe / totalPlayed) * 100) + '%';
        document.getElementById('barLosses').style.width = ((teamStats.pp / totalPlayed) * 100) + '%';
    }

    const table = document.getElementById('topScorersTable');
    if (table) {
        const sortedScorers = [...playerList].filter(p => p.goals > 0).sort((a, b) => b.goals - a.goals).slice(0, 5);
        // IMPORTANTE: el ranking de dashboard se oculta con estado vacío si todavía no existen goles.
        table.innerHTML = sortedScorers.length ? sortedScorers.map(p => `
            <tr>
                <td class="py-3 text-sm border-b border-white/6">${escapeHTML(p.name)}</td>
                <td class="text-right font-extrabold text-success border-b border-white/6">${p.goals} Goles</td>
            </tr>
        `).join('') : '<tr><td colspan="2" class="text-center py-6 text-xs text-slate-500">Sin goles registrados</td></tr>';
    }

    const recentList = document.getElementById('recentMatchesList');
    if (recentList) {
        // IMPORTANTE: la racha reciente siempre toma los últimos 5 partidos con resultado definido.
        recentList.innerHTML = advanced.recentMatches.length ? advanced.recentMatches.map(m => `
            <div class="flex items-center justify-between gap-3 py-3 border-b border-white/6">
                <div class="min-w-0">
                    <div class="text-xs text-slate-500">${new Date(m.date).toLocaleDateString()}</div>
                    <div class="text-[11px] font-bold text-slate-300 truncate">${escapeHTML(m.opponent ? `vs ${m.opponent}` : 'Rival sin registrar')}</div>
                    <div class="text-lg font-extrabold text-white">
                        <span class="${m.result === 'Victoria' ? 'text-success' : ''}">${m.goalsScored}</span>
                        <span class="text-slate-500 mx-1">-</span>
                        <span class="${m.result === 'Derrota' ? 'text-danger' : ''}">${m.goalsConceded}</span>
                    </div>
                </div>
                <div class="w-9 h-9 rounded-full border flex items-center justify-center text-xs font-extrabold ${getResultBadgeClass(m.result)}" title="${escapeHTML(m.result)}">
                    ${escapeHTML(getResultShort(m.result))}
                </div>
            </div>
        `).join('') : '<div class="text-center py-6 text-xs text-slate-500">Sin partidos recientes</div>';
    }
};

window.renderStatsTable = () => {
    const tbody = document.getElementById('statsTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    const matches = tournamentData.matches || [];
    const advanced = calculateAdvancedMetrics(matches);

    // IMPORTANTE: la tabla individual hereda goles/P, participación goleadora, tarjetas/P y MVP del cálculo central.
    const sorted = advanced.playerList.sort((a, b) => b.mvpScore - a.mvpScore || b.goals - a.goals);
    if (!sorted.length) {
        tbody.innerHTML = '<tr><td colspan="13" class="text-center py-8 text-xs text-slate-500">Sin jugadores registrados para calcular estadísticas individuales.</td></tr>';
        return;
    }

    sorted.forEach(s => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="py-3 pl-2 font-medium text-white">${escapeHTML(s.name)}</td>
            <td class="text-center text-slate-400">${s.matches}</td>
            <td class="text-center font-bold text-success">${s.goals}</td>
            <td class="text-center text-slate-400 text-[10px]">${s.goalPerMatch.toFixed(2)}</td>
            <td class="text-center text-primary text-[10px] font-bold">${s.goalParticipation.toFixed(0)}%</td>
            <td class="text-center text-yellow-500">${s.yellow}</td>
            <td class="text-center text-blue-400">${s.blue}</td>
            <td class="text-center text-red-500">${s.red}</td>
            <td class="text-center text-yellow-500 text-[10px]">${s.cardsPerMatch.toFixed(2)}</td>
            <td class="text-center text-purple-300 font-bold">${s.mvpScore.toFixed(1)}</td>
            <!-- IMPORTANTE: MVPs y minutos aparecen aquí solo si fueron guardados en partidos nuevos. -->
            <td class="text-center text-amber-300 font-bold">${s.mvpAwards || '-'}</td>
            <td class="text-center text-sky-300">${s.minutes || '-'}</td>
            <td class="text-right text-danger font-mono pr-2">${s.debt > 0 ? formatCOP(s.debt) : '-'}</td>
        `;
        tbody.appendChild(tr);
    });
};

// --- CRUD JUGADORES ---
window.openPlayerModal = (playerId = null) => {
    const modal = document.getElementById('playerModal');
    const nameIn = document.getElementById('playerModalName');
    const numIn = document.getElementById('playerModalNum');
    const idIn = document.getElementById('editPlayerId');

    if (playerId) {
        const p = players.find(x => x.id === playerId);
        document.getElementById('playerModalTitle').textContent = "Editar Jugador";
        nameIn.value = p.name;
        numIn.value = p.number;
        idIn.value = p.id;
    } else {
        document.getElementById('playerModalTitle').textContent = "Nuevo Jugador";
        nameIn.value = "";
        numIn.value = "";
        idIn.value = "";
    }

    modal.classList.remove('hidden');
};

window.savePlayerForm = async () => {
    try {
        const id = document.getElementById('editPlayerId').value;
        const name = document.getElementById('playerModalName').value.trim();
        const number = parseInt(document.getElementById('playerModalNum').value);

        if (!name || !number) return window.showToast("Faltan datos", true);

        if (id) {
            await updateDoc(doc(collection(db, currentPlayersCollection), id), { name, number });
        } else {
            await setDoc(doc(collection(db, currentPlayersCollection)), {
                name,
                number,
                tournament: currentTournament,
                totalPaid: 0,
                payments: [],
                cardDebt: 0,
                finesCredit: 0
            });
        }

        window.closeModal('playerModal');
        setTimeout(() => window.autoRecalculateFees(), 500);
        window.showToast(id ? 'Actualizado' : 'Creado');
    } catch (e) {
        console.error(e);
        window.showToast("Error al guardar jugador", true);
    }
};

window.deletePlayer = async (id) => {
    if (!confirm("¿Eliminar jugador?")) return;

    try {
        await deleteDoc(doc(collection(db, currentPlayersCollection), id));
        window.showToast("Eliminado");
        setTimeout(() => window.autoRecalculateFees(), 500);
    } catch (e) {
        console.error(e);
        window.showToast("Error al eliminar", true);
    }
};

// --- PAGOS ---
window.addPayment = async () => {
    try {
        const id = document.getElementById('payPlayerSelect').value;
        const amount = parseFloat(document.getElementById('payAmount').value);
        const type = document.getElementById('payTypeSelect')?.value || 'inscripcion';
        const matchId = document.getElementById('payMatchSelect')?.value || '';

        if (!id || !amount) return window.showToast("Datos incompletos", true);
        if (type === 'arbitraje' && !matchId) return window.showToast("Selecciona un partido para arbitraje", true);

        const p = players.find(x => x.id === id);
        if (!p) return window.showToast("Jugador no encontrado", true);
        const newPay = {
            id: crypto.randomUUID(),
            date: new Date().toISOString(),
            amount,
            type,
            matchId: matchId || null,
            playerName: p?.name || '',
            origin: getPaymentOrigin(),
            createdAt: new Date().toISOString()
        };

        const updatedPayments = [...(p.payments || []), newPay];

        if (type === 'inscripcion') {
            // IMPORTANTE: totalPaid se deriva del historial de inscripción para evitar saldos acumulados incorrectos.
            await updateDoc(doc(collection(db, currentPlayersCollection), id), {
                totalPaid: getPlayerTotalPaidFromHistory({ ...p, payments: updatedPayments }),
                payments: updatedPayments
            });
        } else if (type === 'tarjeta') {
            if (matchId) {
                const matches = [...(tournamentData.matches || [])];
                const matchIndex = matches.findIndex(m => String(m.id) === String(matchId));
                if (matchIndex < 0) return window.showToast("Partido no encontrado", true);

                const match = { ...matches[matchIndex] };
                const details = match.playerDetails || {};
                const fineTotal = calculateMatchFine(details[id] || {});
                if (fineTotal <= 0) return window.showToast("El jugador no tiene multa en este partido", true);

                const payments = { ...(match.refereePayments || {}) };
                const playerPayment = { ...(payments[id] || {}) };
                const currentPaid = Math.max(0, parseFloat(playerPayment.finesPaidAmount) || 0);
                const newPaid = Math.min(fineTotal, currentPaid + amount);
                newPay.amount = Math.max(0, newPaid - currentPaid);
                if (newPay.amount <= 0) return window.showToast("La multa ya está cubierta", true);

                playerPayment.finesPaidAmount = newPaid;
                if ('paidFines' in playerPayment) delete playerPayment.paidFines;

                payments[id] = playerPayment;
                match.refereePayments = payments;
                matches[matchIndex] = match;

                await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), { matches });
                await updateDoc(doc(collection(db, currentPlayersCollection), id), { payments: updatedPayments });

                tournamentData.matches = matches;
                await recalculateAllDebts(matches);
            } else {
                const newFinesCredit = (p.finesCredit || 0) + amount;
                await updateDoc(doc(collection(db, currentPlayersCollection), id), {
                    payments: updatedPayments,
                    finesCredit: newFinesCredit
                });
                p.payments = updatedPayments;
                p.finesCredit = newFinesCredit;
                await recalculateAllDebts(tournamentData.matches || []);
            }
        } else if (type === 'arbitraje') {
            const matches = [...(tournamentData.matches || [])];
            const matchIndex = matches.findIndex(m => String(m.id) === String(matchId));
            if (matchIndex < 0) return window.showToast("Partido no encontrado", true);

            const match = { ...matches[matchIndex] };
            const payments = { ...(match.refereePayments || {}) };
            const playerPayment = { ...(payments[id] || {}) };
            const totalPlayers = (match.presentPlayers || []).length;
            const perPlayer = totalPlayers > 0 ? (match.refereeValue || 0) / totalPlayers : 0;
            const currentPaid = Math.max(0, parseFloat(playerPayment.refPaidAmount) || 0);
            const newPaid = currentPaid + amount;
            newPay.amount = Math.max(0, newPaid - currentPaid);

            playerPayment.refPaidAmount = newPaid;
            playerPayment.paidRef = perPlayer > 0 ? newPaid >= perPlayer : false;
            payments[id] = playerPayment;
            match.refereePayments = payments;
            matches[matchIndex] = match;

            await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), { matches });
            await updateDoc(doc(collection(db, currentPlayersCollection), id), { payments: updatedPayments });

            tournamentData.matches = matches;
        }

        p.payments = updatedPayments;
        p.totalPaid = getPlayerTotalPaidFromHistory(p);
        document.getElementById('payAmount').value = '';
        window.renderFinances();
        window.renderDashboard();
        window.showToast('Pago registrado');
    } catch (e) {
        console.error(e);
        window.showToast("Error al registrar pago", true);
    }
};

window.printPaymentReceipt = (playerId, paymentId) => {
    const player = players.find(x => String(x.id) === String(playerId));
    const payment = (player?.payments || []).find(pay => String(pay.id) === String(paymentId));
    if (!player || !payment) return window.showToast('Pago no encontrado', true);

    const type = PAYMENT_TYPE_LABELS[payment.type || 'inscripcion'] || 'Inscripción';
    const matchLabel = payment.matchId ? getMatchLabel(payment.matchId) : 'No aplica';
    const origin = payment.origin || payment.createdBy || payment.user || 'sin origen';
    const receiptHtml = `
        <!doctype html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Comprobante ${escapeHTML(payment.id || '')}</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 32px; color: #111827; }
                .receipt { max-width: 640px; border: 1px solid #d1d5db; border-radius: 18px; padding: 28px; }
                h1 { margin: 0 0 6px; font-size: 24px; }
                .muted { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
                .row { display: flex; justify-content: space-between; gap: 20px; border-bottom: 1px solid #e5e7eb; padding: 12px 0; }
                .amount { font-size: 30px; font-weight: 800; color: #059669; }
                button { margin-top: 24px; padding: 12px 18px; border: 0; border-radius: 12px; background: #111827; color: white; font-weight: 700; cursor: pointer; }
                @media print { button { display: none; } body { margin: 0; } .receipt { border: 0; } }
            </style>
        </head>
        <body>
            <div class="receipt">
                <div class="muted">Comprobante simple de pago</div>
                <h1>${escapeHTML(tournamentData.name || 'Equipo')}</h1>
                <div class="amount">${formatCOP(payment.amount)}</div>
                <div class="row"><strong>Fecha</strong><span>${escapeHTML(new Date(payment.date).toLocaleString())}</span></div>
                <div class="row"><strong>Jugador</strong><span>${escapeHTML(player.name)}</span></div>
                <div class="row"><strong>Tipo</strong><span>${escapeHTML(type)}</span></div>
                <div class="row"><strong>Partido asociado</strong><span>${escapeHTML(matchLabel)}</span></div>
                <div class="row"><strong>Usuario / origen</strong><span>${escapeHTML(origin)}</span></div>
                <div class="row"><strong>ID pago</strong><span>${escapeHTML(payment.id || '')}</span></div>
                <button onclick="window.print()">Imprimir comprobante</button>
            </div>
        </body>
        </html>`;

    const receiptWindow = window.open('', '_blank', 'width=720,height=760');
    if (!receiptWindow) return window.showToast('No se pudo abrir el comprobante', true);
    receiptWindow.document.write(receiptHtml);
    receiptWindow.document.close();
};

window.openPaymentHistory = (playerId) => {
    const p = players.find(x => x.id === playerId);
    const list = document.getElementById('historyList');
    const finesList = document.getElementById('finesHistoryList');
    document.getElementById('historyModalTitle').textContent = p.name;

    if (!p.payments || p.payments.length === 0) {
        list.innerHTML = '<div class="text-center text-slate-500 mt-10">Sin pagos registrados</div>';
    } else {
        list.innerHTML = [...p.payments].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).map(pay => {
            const type = pay.type || 'inscripcion';
            const typeLabel = escapeHTML(PAYMENT_TYPE_LABELS[type] || 'Inscripción');
            // IMPORTANTE: getMatchLabel combina datos editables del partido; se sanea antes de innerHTML.
            const matchLabel = pay.matchId ? escapeHTML(getMatchLabel(pay.matchId)) : 'Sin partido asociado';
            const origin = escapeHTML(pay.origin || pay.createdBy || pay.user || 'sin origen');
            const dateLabel = pay.date ? new Date(pay.date).toLocaleString() : 'Sin fecha';

            return `
                <div class="bg-white/5 p-4 rounded-2xl mb-2 border border-white/8">
                    <div class="flex justify-between items-start gap-3">
                        <div class="min-w-0">
                            <div class="font-extrabold text-success">${formatCOP(pay.amount)}</div>
                            <div class="text-xs text-slate-500">${escapeHTML(dateLabel)}</div>
                            <div class="text-[10px] text-slate-400 uppercase font-bold mt-1">${typeLabel}</div>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            <button title="Comprobante" onclick="window.printPaymentReceipt('${playerId}', '${pay.id}')" class="text-slate-500 hover:text-success px-2">
                                <i class="fa-solid fa-print"></i>
                            </button>
                            <button title="Eliminar pago" onclick="window.deletePayment('${playerId}', '${pay.id}')" class="text-slate-500 hover:text-danger px-2">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-[11px] text-slate-400">
                        <div><span class="text-slate-500">Jugador:</span> ${escapeHTML(p.name)}</div>
                        <div><span class="text-slate-500">Partido:</span> ${matchLabel}</div>
                        <div><span class="text-slate-500">Origen:</span> ${origin}</div>
                        <div><span class="text-slate-500">ID:</span> ${escapeHTML(pay.id || 'sin id')}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    const matches = tournamentData.matches || [];
    const fineRows = matches.map((m) => {
        const details = m.playerDetails || {};
        const fine = calculateMatchFine(details[playerId] || {});
        const payments = m.refereePayments || {};
        const paid = getFinePaidFromHistory(playerId, m.id, payments[playerId]?.finesPaidAmount);

        if (fine <= 0 && paid <= 0) return '';

        const pending = Math.max(0, fine - paid);
        const statusLabel = pending <= 0
            ? '<span class="text-success text-[10px] font-bold">OK</span>'
            : '<span class="text-danger text-[10px] font-bold">PEND</span>';

        const inputId = `finePay-${playerId}-${m.id}`;

        return `
            <div class="bg-white/5 p-4 rounded-2xl mb-2 border border-white/8">
                <div class="flex justify-between items-center">
                    <div>
                        <div class="text-xs text-slate-500">${new Date(m.date).toLocaleDateString()}</div>
                        <div class="text-xs text-danger font-bold mt-1">Multa: ${formatCOP(fine)}</div>
                        <div class="text-xs text-slate-400 mt-1">Pagado: ${formatCOP(paid)}</div>
                    </div>
                    ${statusLabel}
                </div>
                <div class="flex items-center gap-2 mt-3">
                    <input type="number" min="0" id="${inputId}" class="w-full bg-white/5 border border-white/8 rounded-xl text-center text-white text-[11px] py-2" placeholder="Monto a pagar">
                    <button onclick="window.registerFinePayment('${playerId}', '${m.id}')" class="text-[10px] px-3 py-2 rounded-xl bg-warning text-ink font-bold">Abonar</button>
                    <button onclick="window.registerFinePayment('${playerId}', '${m.id}', true)" class="text-[10px] px-3 py-2 rounded-xl bg-success text-white font-bold">Total</button>
                </div>
                <div class="text-[10px] text-slate-500 mt-2">Pendiente: ${formatCOP(pending)}</div>
            </div>
        `;
    }).filter(Boolean).join('');

    finesList.innerHTML = fineRows || '<div class="text-center text-slate-500 mt-6">Sin multas registradas</div>';
    document.getElementById('historyModal').classList.remove('hidden');
};

window.registerFinePayment = async (playerId, matchId, payFull = false) => {
    try {
        const matches = [...(tournamentData.matches || [])];
        const matchIndex = matches.findIndex(m => String(m.id) === String(matchId));
        if (matchIndex < 0) return window.showToast("Partido no encontrado", true);

        const match = { ...matches[matchIndex] };
        const details = match.playerDetails || {};
        const fineTotal = calculateMatchFine(details[playerId] || {});
        if (fineTotal <= 0) return window.showToast("Este partido no tiene multas", true);

        const inputId = `finePay-${playerId}-${matchId}`;
        const amount = Math.max(0, parseFloat(document.getElementById(inputId)?.value) || 0);
        if (!payFull && amount <= 0) return window.showToast("Ingresa un monto válido", true);

        const payments = { ...(match.refereePayments || {}) };
        const playerPayment = { ...(payments[playerId] || {}) };
        const currentPaid = Math.max(0, parseFloat(playerPayment.finesPaidAmount) || 0);
        const newPaid = payFull ? fineTotal : Math.min(fineTotal, currentPaid + amount);
        const paidDelta = Math.max(0, newPaid - currentPaid);
        if (paidDelta <= 0) return window.showToast("La multa ya está cubierta", true);

        playerPayment.finesPaidAmount = newPaid;
        if ('paidFines' in playerPayment) delete playerPayment.paidFines;

        payments[playerId] = playerPayment;
        match.refereePayments = payments;
        matches[matchIndex] = match;

        const p = players.find(x => x.id === playerId);
        const newPay = {
            id: crypto.randomUUID(),
            date: new Date().toISOString(),
            amount: paidDelta,
            type: 'tarjeta',
            matchId,
            playerName: p?.name || '',
            origin: getPaymentOrigin(),
            createdAt: new Date().toISOString()
        };
        const updatedPayments = [...(p?.payments || []), newPay];

        await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), { matches });
        if (p) await updateDoc(doc(collection(db, currentPlayersCollection), playerId), { payments: updatedPayments });
        tournamentData.matches = matches;
        if (p) p.payments = updatedPayments;

        await recalculateAllDebts(matches);
        window.renderFinances();
        window.renderDashboard();
        window.openPaymentHistory(playerId);
        window.showToast("Pago de multa registrado");
    } catch (e) {
        console.error(e);
        window.showToast("Error: " + e.message, true);
    }
};

window.deletePayment = async (playerId, paymentId) => {
    if (!confirm("¿Borrar pago?")) return;

    try {
        const p = players.find(x => x.id === playerId);
        if (!p) return window.showToast("Jugador no encontrado", true);
        const targetPayment = (p.payments || []).find(pay => pay.id === paymentId);
        if (!targetPayment) return window.showToast("Pago no encontrado", true);

        const newPayments = (p.payments || []).filter(pay => pay.id !== paymentId);
        // IMPORTANTE: al borrar se recalculan saldos desde el historial restante, no restando acumulados previos.
        const newTotal = getPlayerTotalPaidFromHistory({ ...p, payments: newPayments });

        const updates = { totalPaid: newTotal, payments: newPayments };

        if (targetPayment.type === 'tarjeta') {
            if (targetPayment.matchId) {
                const matches = [...(tournamentData.matches || [])];
                const matchIndex = matches.findIndex(m => String(m.id) === String(targetPayment.matchId));

                if (matchIndex >= 0) {
                    const match = { ...matches[matchIndex] };
                    const details = match.playerDetails || {};
                    const fineTotal = calculateMatchFine(details[playerId] || {});
                    const payments = { ...(match.refereePayments || {}) };
                    const playerPayment = { ...(payments[playerId] || {}) };
                    const currentPaid = Math.max(0, parseFloat(playerPayment.finesPaidAmount) || 0);
                    const newPaid = Math.max(0, Math.min(fineTotal, currentPaid - targetPayment.amount));

                    playerPayment.finesPaidAmount = newPaid;
                    payments[playerId] = playerPayment;
                    match.refereePayments = payments;
                    matches[matchIndex] = match;

                    await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), { matches });
                    tournamentData.matches = matches;
                    await recalculateAllDebts(matches);
                }
            } else {
                updates.finesCredit = Math.max(0, (p.finesCredit || 0) - targetPayment.amount);
            }
        }

        if (targetPayment.type === 'arbitraje' && targetPayment.matchId) {
            const matches = [...(tournamentData.matches || [])];
            const matchIndex = matches.findIndex(m => String(m.id) === String(targetPayment.matchId));

            if (matchIndex >= 0) {
                const match = { ...matches[matchIndex] };
                const payments = { ...(match.refereePayments || {}) };
                const playerPayment = { ...(payments[playerId] || {}) };
                const totalPlayers = (match.presentPlayers || []).length;
                const perPlayer = totalPlayers > 0 ? (match.refereeValue || 0) / totalPlayers : 0;
                const currentPaid = Math.max(0, parseFloat(playerPayment.refPaidAmount) || 0);
                const newPaid = Math.max(0, currentPaid - targetPayment.amount);

                playerPayment.refPaidAmount = newPaid;
                playerPayment.paidRef = perPlayer > 0 ? newPaid >= perPlayer : false;
                payments[playerId] = playerPayment;
                match.refereePayments = payments;
                matches[matchIndex] = match;

                await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), { matches });
                tournamentData.matches = matches;
            }
        }

        await updateDoc(doc(collection(db, currentPlayersCollection), playerId), updates);
        p.payments = newPayments;
        p.totalPaid = newTotal;

        if (updates.finesCredit !== undefined) p.finesCredit = updates.finesCredit;

        await recalculateAllDebts(tournamentData.matches || []);
        window.renderFinances();
        window.renderDashboard();

        window.openPaymentHistory(playerId);
        window.showToast("Pago eliminado");
    } catch (e) {
        console.error(e);
        window.showToast("Error al eliminar pago", true);
    }
};

// --- MATCH SELECTION / STATS ---
window.toggleMatchSelection = (id) => {
    if (!matchSelection[id]) {
        matchSelection[id] = {
            selected: false,
            paidRef: false,
            refPaidAmount: 0,
            finesPaidAmount: 0,
            stats: { goals: 0, yellow: 0, blue: 0, red: 0 }
        };
    }

    matchSelection[id].selected = !matchSelection[id].selected;
    if (!matchSelection[id].selected) {
        matchSelection[id].paidRef = false;
        matchSelection[id].refPaidAmount = 0;
        matchSelection[id].finesPaidAmount = 0;
    }

    window.renderMatchSelector();
};

window.toggleMatchPayRef = (id) => {
    if (matchSelection[id]) {
        matchSelection[id].paidRef = !matchSelection[id].paidRef;
        matchSelection[id].refPaidAmount = matchSelection[id].paidRef ? null : 0;
        window.renderMatchSelector();
    }
};

window.updateMatchFinePayment = (id, value) => {
    if (matchSelection[id]) {
        matchSelection[id].finesPaidAmount = Math.max(0, parseFloat(value) || 0);
        window.calcRef();
    }
};

window.setMatchFineFull = (id) => {
    if (matchSelection[id]) {
        const fineAmount = calculateMatchFine(matchSelection[id].stats || {});
        matchSelection[id].finesPaidAmount = fineAmount;
        window.renderMatchSelector();
    }
};

window.registerHistoricalCardPayment = async (playerId, payFull = false) => {
    try {
        const p = players.find(x => x.id === playerId);
        if (!p) return window.showToast("Jugador no encontrado", true);

        const outstanding = Math.max(0, p.cardDebt || 0);
        if (outstanding <= 0) return window.showToast("No hay deuda histórica pendiente", true);

        const inputId = `historicDebt-${playerId}`;
        const rawAmount = Math.max(0, parseFloat(document.getElementById(inputId)?.value) || 0);
        if (!payFull && rawAmount <= 0) return window.showToast("Ingresa un monto válido", true);

        const amount = payFull ? outstanding : Math.min(outstanding, rawAmount);
        const newPay = {
            id: crypto.randomUUID(),
            date: new Date().toISOString(),
            amount,
            type: 'tarjeta',
            matchId: null,
            playerName: p?.name || '',
            origin: getPaymentOrigin(),
            createdAt: new Date().toISOString()
        };

        const updatedPayments = [...(p.payments || []), newPay];
        const newFinesCredit = (p.finesCredit || 0) + amount;

        await updateDoc(doc(collection(db, currentPlayersCollection), playerId), {
            payments: updatedPayments,
            finesCredit: newFinesCredit
        });

        p.payments = updatedPayments;
        p.finesCredit = newFinesCredit;
        p.cardDebt = Math.max(0, (p.cardDebt || 0) - amount);

        await recalculateAllDebts(tournamentData.matches || []);
        window.renderMatchSelector();
        window.renderFinances();
        window.renderDashboard();
        window.showToast("Pago de deuda histórica registrado");
    } catch (e) {
        console.error(e);
        window.showToast("Error: " + e.message, true);
    }
};

window.calcRef = () => {
    const total = parseFloat(document.getElementById('refPrice').value) || 0;
    const selectedIds = Object.keys(matchSelection).filter(k => matchSelection[k].selected);
    const count = selectedIds.length;
    const perPlayer = count > 0 ? total / count : 0;

    let collectedRef = 0;
    let collectedFines = 0;

    selectedIds.forEach(pid => {
        const state = matchSelection[pid];
        if (!state) return;

        const refPaidAmount = (state.refPaidAmount !== null && state.refPaidAmount !== undefined)
            ? Math.max(0, parseFloat(state.refPaidAmount) || 0)
            : (state.paidRef ? perPlayer : 0);

        collectedRef += Math.min(refPaidAmount, perPlayer);

        const fineAmount = calculateMatchFine(state.stats || {});
        const paidAmount = Math.max(0, parseFloat(state.finesPaidAmount) || 0);
        collectedFines += Math.min(fineAmount, paidAmount);
    });

    safeText('convocadosCount', `${count} Jugadores`);
    safeText('costPerPlayer', formatCOP(perPlayer));
    safeText('totalCollectedMatch', formatCOP(collectedRef));
    safeText('totalFinesCollectedMatch', formatCOP(collectedFines));
};

window.openPlayerStatsModal = () => {
    const selectedIds = Object.keys(matchSelection).filter(id => matchSelection[id].selected);
    if (selectedIds.length === 0) {
        window.showToast("Selecciona jugadores primero", true);
    }

    window.renderPlayerStatsInputs();
    document.getElementById('playerStatsModal').classList.remove('hidden');
};

window.renderPlayerStatsInputs = () => {
    const container = document.getElementById('playerStatsInputs');
    container.innerHTML = '';

    const selectedIds = Object.keys(matchSelection).filter(id => matchSelection[id] && matchSelection[id].selected);

    if (selectedIds.length === 0) {
        container.innerHTML = '<div class="text-center text-slate-500 mt-10">Selecciona jugadores en la lista anterior primero.</div>';
        return;
    }

    selectedIds.forEach(pid => {
        const p = players.find(x => x.id === pid);
        if (!matchSelection[pid].stats) {
            matchSelection[pid].stats = { goals: 0, yellow: 0, blue: 0, red: 0 };
        }

        const stats = matchSelection[pid].stats;

        if (p) {
            const row = document.createElement('div');
            row.className = "flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 bg-white/5 p-4 rounded-2xl mb-3 border border-white/8";
            row.innerHTML = `
                <div class="w-full lg:w-1/3 font-bold text-slate-300 text-sm">${escapeHTML(p.name)}</div>
                <div class="flex gap-3 flex-wrap">
                    <div class="flex flex-col items-center">
                        <span class="text-[10px] text-success mb-1">Goles</span>
                        <input type="number" min="0" class="w-12 bg-white/5 border border-white/8 rounded-xl text-center text-white py-2" value="${stats.goals || 0}" onchange="window.updateStat('${pid}', 'goals', this.value)">
                    </div>
                    <div class="flex flex-col items-center">
                        <span class="text-[10px] text-yellow-500 mb-1">Ama</span>
                        <input type="number" min="0" class="w-12 bg-white/5 border border-white/8 rounded-xl text-center text-white py-2" value="${stats.yellow || 0}" onchange="window.updateStat('${pid}', 'yellow', this.value)">
                    </div>
                    <div class="flex flex-col items-center">
                        <span class="text-[10px] text-blue-400 mb-1">Azul</span>
                        <input type="number" min="0" class="w-12 bg-white/5 border border-white/8 rounded-xl text-center text-white py-2" value="${stats.blue || 0}" onchange="window.updateStat('${pid}', 'blue', this.value)">
                    </div>
                    <div class="flex flex-col items-center">
                        <span class="text-[10px] text-red-500 mb-1">Roja</span>
                        <input type="number" min="0" class="w-12 bg-white/5 border border-white/8 rounded-xl text-center text-white py-2" value="${stats.red || 0}" onchange="window.updateStat('${pid}', 'red', this.value)">
                    </div>
                    <!-- IMPORTANTE: los minutos son opcionales y solo impactan reportes cuando se capturan. -->
                    <div class="flex flex-col items-center">
                        <span class="text-[10px] text-sky-300 mb-1">Min</span>
                        <input type="number" min="0" class="w-14 bg-white/5 border border-white/8 rounded-xl text-center text-white py-2" value="${stats.minutes || ''}" onchange="window.updateStat('${pid}', 'minutes', this.value)">
                    </div>
                </div>
            `;
            container.appendChild(row);
        }
    });
};

window.updateStat = (pid, stat, val) => {
    if (matchSelection[pid]) {
        if (!matchSelection[pid].stats) {
            matchSelection[pid].stats = { goals: 0, yellow: 0, blue: 0, red: 0 };
        }
        matchSelection[pid].stats[stat] = parseInt(val) || 0;
    }
};

window.autoSumGlobalStats = () => {
    let totalG = 0, totalY = 0, totalB = 0, totalR = 0;

    Object.values(matchSelection).forEach(p => {
        if (p.selected && p.stats) {
            totalG += (p.stats.goals || 0);
            totalY += (p.stats.yellow || 0);
            totalB += (p.stats.blue || 0);
            totalR += (p.stats.red || 0);
        }
    });

    document.getElementById('gf').value = totalG;
    document.getElementById('yc').value = totalY;
    document.getElementById('bc').value = totalB;
    document.getElementById('rc').value = totalR;

    window.showToast("Marcador Global Sincronizado");
};

// --- PARTIDOS ---
window.saveMatch = async () => {
    try {
        const gf = parseInt(document.getElementById('gf').value);
        const gc = parseInt(document.getElementById('gc').value);
        const editId = document.getElementById('editingMatchId').value;
        const refValue = parseFloat(document.getElementById('refPrice').value) || 0;
        const selectedIds = Object.keys(matchSelection).filter(k => matchSelection[k].selected);

        // IMPORTANTE: datos contextuales nuevos del partido; son opcionales para conservar compatibilidad histórica.
        const opponent = document.getElementById('matchOpponent')?.value.trim() || '';
        const round = document.getElementById('matchRound')?.value.trim() || '';
        const venue = document.getElementById('matchVenue')?.value.trim() || '';
        const phase = document.getElementById('matchPhase')?.value.trim() || '';
        const notes = document.getElementById('matchNotes')?.value.trim() || '';
        const mvpPlayerId = document.getElementById('matchMvp')?.value || '';

        if (selectedIds.length === 0) return window.showToast('Selecciona al menos 1 jugador', true);
        if (mvpPlayerId && !selectedIds.includes(mvpPlayerId)) return window.showToast('El MVP debe estar en la convocatoria', true);

        let result = 'Derrota';
        let points = 0;
        if (gf > gc) {
            result = 'Victoria';
            points = 2;
        } else if (gf === gc) {
            result = 'Empate';
            points = 1;
        }

        const playerDetailsMap = {};
        selectedIds.forEach(pid => {
            playerDetailsMap[pid] = matchSelection[pid].stats || { goals: 0, yellow: 0, blue: 0, red: 0 };
        });

        // IMPORTANTE: guarda una copia de la alineación seleccionada para que futuros cambios tácticos no alteren este partido.
        const selectedMatchLineupId = document.getElementById('matchLineupSelect')?.value || selectedLineupId || '';
        const selectedMatchLineup = getSavedLineups().find(l => l.id === selectedMatchLineupId);
        const lineupUsed = structuredClone(selectedMatchLineup?.slots || currentLineup || {});
        const lineupMetaUsed = structuredClone(selectedMatchLineup?.meta || currentLineupMeta || {});
        const lineupUsedName = selectedMatchLineup?.name || document.getElementById('lineupName')?.value.trim() || '';
        const previousMatch = (tournamentData.matches || []).find(m => m.id === editId);

        const matchObj = {
            id: editId || crypto.randomUUID(),
            date: previousMatch?.date || new Date().toISOString(),
            goalsScored: gf,
            goalsConceded: gc,
            yellowCards: parseInt(document.getElementById('yc').value) || 0,
            blueCards: parseInt(document.getElementById('bc').value) || 0,
            redCards: parseInt(document.getElementById('rc').value) || 0,
            refereeValue: refValue,
            // IMPORTANTE: bloque extendido para identificar rival, jornada, sede, fase, notas y MVP.
            opponent,
            round,
            venue,
            phase,
            notes,
            mvpPlayerId,
            // IMPORTANTE: bloque deportivo; conserva convocatoria, pagos, detalle individual y alineación usada.
            presentPlayers: selectedIds,
            refereePayments: matchSelection,
            playerDetails: playerDetailsMap,
            lineupUsed,
            lineupMetaUsed,
            lineupUsedId: selectedMatchLineupId,
            lineupUsedName,
            result,
            points
        };

        let newMatches = [...(tournamentData.matches || [])];
        if (editId) {
            const idx = newMatches.findIndex(m => m.id === editId);
            if (idx >= 0) newMatches[idx] = matchObj;
        } else {
            newMatches.push(matchObj);
        }

        const playerDebts = calculatePlayerDebts(newMatches);
        const batch = writeBatch(db);

        batch.update(doc(collection(db, currentTournamentCollection), currentTournament), { matches: newMatches });

        Object.keys(playerDebts).forEach(pid => {
            const p = players.find(x => x.id === pid);
            if (p && p.cardDebt !== playerDebts[pid]) {
                batch.update(doc(collection(db, currentPlayersCollection), pid), { cardDebt: playerDebts[pid] });
            }
        });

        await batch.commit();
        window.resetMatchForm();
        window.showToast('Partido guardado y deudas recalculadas');
    } catch (e) {
        console.error(e);
        window.showToast("Error: " + e.message, true);
    }
};

window.viewMatchDetails = (matchId) => {
    const m = (tournamentData.matches || []).find(x => x.id === matchId);
    if (!m) return;

    document.getElementById('mdScore').innerHTML = `
        <span class="${m.result === 'Victoria' ? 'text-success' : ''}">${m.goalsScored}</span>
        <span class="text-slate-500 mx-2">-</span>
        <span class="${m.result === 'Derrota' ? 'text-danger' : ''}">${m.goalsConceded}</span>
    `;

    document.getElementById('mdDate').textContent = new Date(m.date).toLocaleDateString();
    document.getElementById('mdYC').textContent = m.yellowCards || 0;
    document.getElementById('mdBC').textContent = m.blueCards || 0;
    document.getElementById('mdRC').textContent = m.redCards || 0;
    document.getElementById('mdRefTotal').textContent = formatCOP(m.refereeValue || 0);

    // IMPORTANTE: bloque de contexto extendido visible en el detalle del partido.
    const metaItems = [
        ['Rival', m.opponent],
        ['Jornada / fecha torneo', m.round],
        ['Sede / cancha', m.venue],
        ['Fase / grupo', m.phase],
        ['MVP', m.mvpPlayerId ? getPlayerName(m.mvpPlayerId) : '']
    ].filter(([, value]) => value);
    const meta = document.getElementById('mdMeta');
    meta.innerHTML = metaItems.length ? metaItems.map(([label, value]) => `
        <div class="glass rounded-2xl p-3">
            <div class="text-[10px] text-slate-500 uppercase tracking-[.16em] font-bold">${escapeHTML(label)}</div>
            <div class="text-sm text-white font-bold mt-1">${escapeHTML(value)}</div>
        </div>
    `).join('') : '<div class="text-center text-slate-500 text-xs md:col-span-2">Sin datos extendidos registrados</div>';

    const notesBox = document.getElementById('mdNotes');
    notesBox.classList.toggle('hidden', !m.notes);
    notesBox.innerHTML = m.notes ? `<div class="text-[10px] text-slate-500 uppercase tracking-[.16em] font-bold mb-2">Observaciones</div>${escapeHTML(m.notes)}` : '';

    // IMPORTANTE: la alineación usada queda congelada por partido aunque currentLineup cambie después.
    const lineupEntries = Object.entries(m.lineupUsed || {}).filter(([, pid]) => pid);
    const lineupBox = document.getElementById('mdLineup');
    lineupBox.classList.toggle('hidden', lineupEntries.length === 0);
    const lineupMeta = m.lineupMetaUsed || {};
    lineupBox.innerHTML = lineupEntries.length ? `
        <div class="text-[10px] text-slate-500 uppercase tracking-[.16em] font-bold mb-3">Alineación usada${m.lineupUsedName ? ` · ${escapeHTML(m.lineupUsedName)}` : ''}</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            ${lineupEntries.map(([slot, pid]) => {
                const meta = lineupMeta[pid] || {};
                const slotLabel = slot === 'gk' ? 'Arquero' : `Pos ${Number(slot) + 1}`;
                const roleLabel = meta.role ? ` · ${PLAYER_ROLES[meta.role] || meta.role}` : '';
                const availabilityLabel = meta.availability ? ` · ${AVAILABILITY_STATES[meta.availability] || meta.availability}` : '';
                return `<div class="text-xs text-slate-300 bg-white/5 rounded-xl px-3 py-2">${slotLabel}: <span class="text-white font-bold">${escapeHTML(getPlayerName(pid))}</span><span class="text-slate-500">${escapeHTML(roleLabel)}${escapeHTML(availabilityLabel)}</span></div>`;
            }).join('')}
        </div>
    ` : '';

    const list = document.getElementById('mdPlayerList');
    const details = m.playerDetails || {};
    const payments = m.refereePayments || {};

    list.innerHTML = (m.presentPlayers || []).map(pid => {
        const p = players.find(x => x.id === pid) || { name: 'Desconocido' };
        const stats = details[pid] || { goals: 0, yellow: 0, blue: 0, red: 0 };
        const payInfo = payments[pid] || { paidRef: false };

        let statsHtml = '';
        if (stats.goals) statsHtml += `<span class="ml-2 text-success">⚽${stats.goals}</span>`;
        if (stats.yellow) statsHtml += `<span class="ml-2 text-yellow-500">🟨${stats.yellow}</span>`;
        if (stats.blue) statsHtml += `<span class="ml-2 text-blue-400">🟦${stats.blue}</span>`;
        if (stats.red) statsHtml += `<span class="ml-2 text-red-500">🟥${stats.red}</span>`;
        if (stats.minutes) statsHtml += `<span class="ml-2 text-sky-300">⏱${stats.minutes}'</span>`;
        if (String(m.mvpPlayerId || '') === String(pid)) statsHtml += `<span class="ml-2 text-purple-300">⭐ MVP</span>`;

        return `
            <div class="flex justify-between items-center py-3 px-4 border border-white/6 rounded-2xl bg-white/[.03]">
                <div class="text-slate-300">${escapeHTML(p.name)} ${statsHtml}</div>
                <span class="text-xs px-3 py-1 rounded-full ${payInfo.paidRef ? 'bg-success/20 text-success border border-success/20' : 'bg-danger/20 text-danger border border-danger/20'}">
                    ${payInfo.paidRef ? 'PAGADO' : 'DEBE'}
                </span>
            </div>
        `;
    }).join('');

    document.getElementById('matchDetailModal').classList.remove('hidden');
};

window.editMatch = (matchId) => {
    const match = (tournamentData.matches || []).find(m => m.id === matchId);
    if (!match) return;

    document.getElementById('gf').value = match.goalsScored;
    document.getElementById('gc').value = match.goalsConceded;
    document.getElementById('yc').value = match.yellowCards || 0;
    document.getElementById('bc').value = match.blueCards || 0;
    document.getElementById('rc').value = match.redCards || 0;
    document.getElementById('refPrice').value = match.refereeValue || 0;
    // IMPORTANTE: al editar se restauran los datos extendidos del partido si existen.
    safeVal('matchOpponent', match.opponent || '');
    safeVal('matchRound', match.round || '');
    safeVal('matchVenue', match.venue || '');
    safeVal('matchPhase', match.phase || '');
    safeVal('matchNotes', match.notes || '');
    safeVal('matchMvp', match.mvpPlayerId || '');
    safeVal('matchLineupSelect', match.lineupUsedId || '');
    safeText('matchLineupHint', match.lineupUsedName ? `Editando con alineación: ${match.lineupUsedName}` : 'Selecciona una alineación guardada para preseleccionar convocados y congelarla al guardar.');

    document.getElementById('editingMatchId').value = match.id;
    document.getElementById('saveMatchBtnText').textContent = "Actualizar Partido";
    document.getElementById('matchFormTitle').textContent = "Editar Partido";
    document.getElementById('matchFormCard').classList.add('border-amber-500');

    matchSelection = structuredClone(match.refereePayments || {});
    const savedStats = match.playerDetails || {};

    Object.keys(matchSelection).forEach(k => {
        if (!matchSelection[k].stats) matchSelection[k].stats = { goals: 0, yellow: 0, blue: 0, red: 0 };
        if (savedStats[k]) {
            matchSelection[k].stats = { ...savedStats[k] };
        }
        if (matchSelection[k].refPaidAmount === undefined) {
            matchSelection[k].refPaidAmount = matchSelection[k].paidRef ? null : 0;
        }
        if (matchSelection[k].finesPaidAmount === undefined || matchSelection[k].finesPaidAmount === null) {
            const legacyFine = matchSelection[k].paidFines ? calculateMatchFine(matchSelection[k].stats) : 0;
            matchSelection[k].finesPaidAmount = legacyFine;
            if ('paidFines' in matchSelection[k]) delete matchSelection[k].paidFines;
        }
    });

    window.renderMatchSelector();
    safeVal('matchMvp', match.mvpPlayerId || '');
    document.querySelector('main').scrollTo({ top: 0, behavior: 'smooth' });
    window.showToast("Modo edición activado");
};

window.deleteMatch = async (matchId) => {
    if (!matchId || matchId === 'undefined') {
        window.showToast("Error: ID inválido", true);
        return;
    }

    if (!confirm("¿Eliminar este partido definitivamente?")) return;

    try {
        const newMatches = (tournamentData.matches || []).filter(m => String(m.id) !== String(matchId));
        await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), { matches: newMatches });
        await recalculateAllDebts(newMatches);
        window.showToast("Partido eliminado correctamente");
    } catch (e) {
        console.error(e);
        window.showToast("Error al eliminar partido", true);
    }
};

window.resetMatchForm = () => {
    document.getElementById('gf').value = 0;
    document.getElementById('gc').value = 0;
    document.getElementById('yc').value = 0;
    document.getElementById('bc').value = 0;
    document.getElementById('rc').value = 0;
    document.getElementById('refPrice').value = '';
    // IMPORTANTE: también se limpian los campos extendidos para no arrastrar datos entre partidos.
    safeVal('matchOpponent', '');
    safeVal('matchRound', '');
    safeVal('matchVenue', '');
    safeVal('matchPhase', '');
    safeVal('matchNotes', '');
    safeVal('matchMvp', '');
    safeVal('matchLineupSelect', '');
    safeText('matchLineupHint', 'Selecciona una alineación guardada para preseleccionar convocados y congelarla al guardar.');
    document.getElementById('editingMatchId').value = '';
    document.getElementById('saveMatchBtnText').textContent = "Guardar Partido";
    document.getElementById('matchFormTitle').textContent = "Registrar Resultado";
    document.getElementById('matchFormCard').classList.remove('border-amber-500');

    matchSelection = {};
    window.renderMatchSelector();
};

// --- CONFIGURACIÓN ---
window.saveConfiguration = async () => {
    try {
        const name = document.getElementById('confName').value;
        const total = parseFloat(document.getElementById('confPrice').value);

        if (!name) return window.showToast("Nombre vacío", true);

        await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), { name: name });
        await window.autoRecalculateFees(total);
        window.showToast('Guardado');
    } catch (e) {
        console.error(e);
        window.showToast("Error al guardar configuración", true);
    }
};

window.autoRecalculateFees = async (explicitTotal = null) => {
    try {
        const hasExplicit = explicitTotal !== null && explicitTotal !== undefined;
        const parsedExplicit = hasExplicit ? parseFloat(explicitTotal) : null;
        if (hasExplicit && !Number.isFinite(parsedExplicit)) return;

        const total = hasExplicit ? parsedExplicit : (tournamentData.totalInscription ?? 0);
        if (!Number.isFinite(total)) return;

        const perPlayer = players.length > 0 ? (total / players.length) : 0;

        await updateDoc(doc(collection(db, currentTournamentCollection), currentTournament), {
            totalInscription: total,
            inscriptionPerPlayer: perPlayer
        });

        window.showToast(`Cuota: ${formatCOP(perPlayer)}`);
    } catch (e) {
        console.error(e);
    }
};

window.confirmResetTournament = async () => {
    if (!currentTournament) return;
    if (!confirm("¿Crear un nuevo torneo y conservar el historial actual?")) return;
    await window.createOfficialTournament();
};

// --- INICIO ---
async function init() {
    try {
        await setPersistence(auth, inMemoryPersistence);
    } catch (e) {}

    onAuthStateChanged(auth, (user) => {
        const statusEl = document.getElementById('connectionStatus');

        if (user) {
            if (statusEl) {
                statusEl.innerHTML = '<i class="fa-solid fa-circle text-success text-[8px] mr-2"></i> Conectado';
            }
            loadTournamentsList();
        } else {
            signInAnonymously(auth)
                .then(() => loadTournamentsList())
                .catch(() => {
                    if (statusEl) {
                        statusEl.innerHTML = '<i class="fa-solid fa-circle text-danger text-[8px] mr-2"></i> Offline';
                    }
                    loadTournamentsList();
                });
        }
    });
}

init();
