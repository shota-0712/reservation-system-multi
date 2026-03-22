
const assert = require('assert');

// Simulate calendar.js logic
// We assume server is UTC (node default)
process.env.TZ = 'UTC';


function getWeeklyAvailability(startDateStr, menuMinutes, businessSettings = {}) {
    const result = [];
    const startHour = businessSettings.startHour || 10;
    const endHour = businessSettings.endHour || 20;
    const holidays = businessSettings.holidays || [];
    const regularHolidays = businessSettings.regularHolidays || [];
    const temporaryBusinessDays = businessSettings.temporaryBusinessDays || [];

    // 1 week loop
    for (let i = 0; i < 7; i++) {
        const [year, month, day] = startDateStr.split('/').map(Number);
        const targetDate = new Date(year, month - 1, day + i); // Local time (UTC)

        const dateStr = `${targetDate.getFullYear()}/${String(targetDate.getMonth() + 1).padStart(2, '0')}/${String(targetDate.getDate()).padStart(2, '0')}`;
        const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][targetDate.getDay()];

        // Closed check
        let isClosed = false;
        if (holidays.includes(dateStr)) isClosed = true;
        else if (temporaryBusinessDays.includes(dateStr)) isClosed = false;
        else if (regularHolidays.includes(targetDate.getDay())) isClosed = true;

        if (isClosed) {
            const slots = [];
            for (let hour = startHour; hour < endHour; hour++) {
                for (let minute = 0; minute < 60; minute += 30) {
                    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                    slots.push({ time: timeStr, status: '休' });
                }
            }
            result.push({ date: dateStr, day: dayOfWeek, slots: slots });
            continue;
        }

        const slots = [];
        for (let hour = startHour; hour < endHour; hour++) {
            for (let minute = 0; minute < 60; minute += 30) {
                const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

                // Slot start time
                const slotStart = new Date(targetDate);
                slotStart.setHours(hour, minute, 0, 0); // Sets hour in UTC!

                const now = new Date(); // Current UTC time

                let status = '⚪︎';
                if (slotStart < now) {
                    status = '-';
                }
                slots.push({ time: timeStr, status, slotStartISO: slotStart.toISOString() });
            }
        }
        result.push({ date: dateStr, day: dayOfWeek, slots: slots });
    }
    return result;
}

// Test
const today = new Date();
// Format JST today date string manually for input
// If server is UTC, we need to be careful what "today" means
// Frontend usually passes formatted date.
const y = today.getFullYear();
const m = String(today.getMonth() + 1).padStart(2, '0');
const d = String(today.getDate()).padStart(2, '0');
const startDateStr = `${y}/${m}/${d}`;

console.log('Testing with startDate:', startDateStr);
console.log('Current Time (UTC):', new Date().toISOString());

const results = getWeeklyAvailability(startDateStr, 60);

// Check first day slots
const firstDay = results[0];
console.log(`Day 1 (${firstDay.date}):`);
firstDay.slots.forEach(s => {
    console.log(`  ${s.time} -> ${s.status} (SlotStart: ${s.slotStartISO})`);
});
