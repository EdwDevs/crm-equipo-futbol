import { getMatchesChronological } from './matches.js';

// IMPORTANTE: fórmula centralizada para que el ranking MVP sea configurable sin tocar cada render.
export const DEFAULT_MVP_FORMULA = { goals: 3, matches: 1, cards: -1 };

export const getMvpFormula = () => ({
    ...DEFAULT_MVP_FORMULA,
    ...(window.mvpFormula || window.MVP_FORMULA || {})
});

export const formatSignedDecimal = (value, digits = 1) => {
    const fixed = Number(value || 0).toFixed(digits);
    return Number(value || 0) > 0 ? `+${fixed}` : fixed;
};

export const calculateAdvancedMetricsForPlayers = (players = [], matches = []) => {
    const formula = getMvpFormula();
    const chronologicalMatches = getMatchesChronological(matches);
    const playerStats = {};
    let totalGF = 0;
    let totalGC = 0;
    let totalCards = 0;
    const teamStats = { pj: 0, pg: 0, pe: 0, pp: 0, pts: 0 };

    players.forEach(p => {
        playerStats[p.id] = {
            id: p.id,
            name: p.name,
            matches: 0,
            goals: 0,
            yellow: 0,
            blue: 0,
            red: 0,
            cards: 0,
            goalPerMatch: 0,
            goalParticipation: 0,
            cardsPerMatch: 0,
            mvpScore: 0,
            mvpAwards: 0,
            minutes: 0,
            lineupStarts: 0,
            debt: p.cardDebt || 0
        };
    });

    chronologicalMatches.forEach(m => {
        totalGF += (m.goalsScored || 0);
        totalGC += (m.goalsConceded || 0);
        totalCards += (m.yellowCards || 0) + (m.blueCards || 0) + (m.redCards || 0);

        // IMPORTANTE: solo los partidos con resultado definido cuentan para porcentajes, PPG y rachas.
        if (m.result) {
            teamStats.pj++;
            if (m.result === 'Victoria') { teamStats.pg++; teamStats.pts += 2; }
            else if (m.result === 'Empate') { teamStats.pe++; teamStats.pts += 1; }
            else if (m.result === 'Derrota') { teamStats.pp++; }
        }

        const details = m.playerDetails || {};
        const presentPlayers = m.presentPlayers || [];
        const presentIds = new Set(presentPlayers.length > 0 ? presentPlayers : Object.keys(details));

        // IMPORTANTE: MVP y alineación guardada enriquecen estadísticas sin romper partidos antiguos.
        if (m.mvpPlayerId && playerStats[m.mvpPlayerId]) playerStats[m.mvpPlayerId].mvpAwards++;
        Object.values(m.lineupUsed || {}).forEach(pid => {
            if (pid && playerStats[pid]) playerStats[pid].lineupStarts++;
        });

        presentIds.forEach(pid => {
            if (!playerStats[pid]) return;
            const playerDetails = details[pid] || {};
            const yellow = playerDetails.yellow || 0;
            const blue = playerDetails.blue || 0;
            const red = playerDetails.red || 0;

            // IMPORTANTE: presentPlayers define asistencia; playerDetails agrega goles y tarjetas del jugador.
            playerStats[pid].matches++;
            playerStats[pid].goals += (playerDetails.goals || 0);
            playerStats[pid].yellow += yellow;
            playerStats[pid].blue += blue;
            playerStats[pid].red += red;
            playerStats[pid].cards += yellow + blue + red;
            playerStats[pid].minutes += Math.max(0, parseInt(playerDetails.minutes) || 0);
        });
    });

    const playerList = Object.values(playerStats).map(s => {
        const goalPerMatch = s.matches > 0 ? s.goals / s.matches : 0;
        const goalParticipation = totalGF > 0 ? (s.goals / totalGF) * 100 : 0;
        const cardsPerMatch = s.matches > 0 ? s.cards / s.matches : 0;
        // IMPORTANTE: los MVPs registrados suman a la fórmula histórica solo cuando el partido trae ese dato nuevo.
        const mvpScore = (s.goals * formula.goals) + (s.matches * formula.matches) + (s.cards * formula.cards) + (s.mvpAwards * 2);

        // IMPORTANTE: estos ratios se guardan numéricos para tablas, tarjetas y gráficas sin recalcular.
        return { ...s, goalPerMatch, goalParticipation, cardsPerMatch, mvpScore };
    });

    const playedMatches = teamStats.pj || 0;
    const diff = totalGF - totalGC;
    const recentMatches = chronologicalMatches.filter(m => m.result).slice(-5);

    return {
        formula,
        matches: chronologicalMatches,
        recentMatches,
        playerStats,
        playerList,
        totalGF,
        totalGC,
        totalCards,
        diff,
        teamStats,
        winPercentage: playedMatches > 0 ? (teamStats.pg / playedMatches) * 100 : 0,
        pointsPerMatch: playedMatches > 0 ? teamStats.pts / playedMatches : 0,
        avgGoalDiff: playedMatches > 0 ? diff / playedMatches : 0,
        avgGF: playedMatches > 0 ? totalGF / playedMatches : 0,
        avgGC: playedMatches > 0 ? totalGC / playedMatches : 0,
        avgCards: playedMatches > 0 ? totalCards / playedMatches : 0
    };
};
