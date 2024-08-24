// src/app.js

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

driverNumber = 0
sessionKey = 0
async function initializeApp() {
    try {
        const drivers = await getDrivers();
        populateDriverDropdown(drivers);
        addDriverSelectionListener();
    } catch (error) {
        console.error('Error initializing app:', error);
    }
}

function populateDriverDropdown(drivers) {
    const driverDropdown = document.getElementById('driver-dropdown');
    driverDropdown.innerHTML = '';  // Clear any existing options

    // Create a Set to keep track of unique driver identifiers
    const uniqueDrivers = new Map();

    drivers.forEach(driver => {
        const key = driver.full_name; // or use `driver.driver_number` if it's more reliable
        if (!uniqueDrivers.has(key)) {
            uniqueDrivers.set(key, driver);
            const option = document.createElement('option');
            option.value = driver.driver_number; // Adjust according to your JSON structure
            option.textContent = driver.full_name;
            driverDropdown.appendChild(option);
        }
    });
}

function addDriverSelectionListener() {
    const driverDropdown = document.getElementById('driver-dropdown');
    driverDropdown.addEventListener('change', async (event) => {
        driverNumber = event.target.value;
        console.log(driverNumber)
        if (driverNumber) {
            try {
                await displayDriverRaceHistory(driverNumber);
            } catch (error) {
                console.error('Error fetching driver race history:', error);
            }
        }
    });
}

async function displayDriverRaceHistory(driverNumber) {
    try {
        console.log('Fetching sessions...');
        const sessions = await getSessions();
        console.log('Sessions fetched:', sessions);

        const races = sessions.filter(session => session.session_type === 'Race');
        console.log('Races filtered:', races);

        console.log('Fetching session keys for driver...');

        const raceList = document.getElementById('session-list');
        raceList.innerHTML = '';  // Clear any existing sessions

        for (const session of races) {
            const sessionKey = session.session_key;

            console.log(`Fetching positions for session ${sessionKey} and driver ${driverNumber}...`);
            const positions = await getPositions(sessionKey, driverNumber);
            console.log('Positions fetched:', positions);

            // Create a container for each race
            const raceContainer = document.createElement('div');
            raceContainer.className = 'race-container';

            const sessionItem = document.createElement('h2');
            sessionItem.textContent = `${session.circuit_short_name} - ${session.country_name} (${session.session_name}) - ${session.year}`;
            raceContainer.appendChild(sessionItem);

            // Create an unordered list to hold lap positions
            const positionList = document.createElement('ul');
            raceContainer.appendChild(positionList);

            // Display lap positions for this race
            displayLapPositions(positions, positionList);

            raceList.appendChild(raceContainer);
        }
    } catch (error) {
        console.error('Error displaying driver race history:', error);
    }
}



function displayLapPositions(positions, positionList) {
    // Clear any existing positions within the current race's list
    positionList.innerHTML = '';

    positions.forEach(position => {
        const positionItem = document.createElement('li');
        positionItem.textContent = `Lap: ${position.lap_number}, Position: ${position.position}`;
        positionList.appendChild(positionItem);
    });
}

