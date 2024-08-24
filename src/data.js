// src/data.js

const BASE_URL = 'http://localhost:8000/api';  // Adjust this base URL to match your server setup

async function getDrivers() {
    const response = await fetch(`${BASE_URL}/drivers`);
    if (!response.ok) throw new Error('Failed to fetch drivers');
    return response.json();
}

async function getCarData(sessionKey, driverNumber) {
    const response = await fetch(`${BASE_URL}/car_data?session_key=${sessionKey}&driver=${driverNumber}`);
    if (!response.ok) throw new Error('Failed to fetch car data');
    return response.json();
}

async function getLaps(sessionKey, driverNumber) {
    const response = await fetch(`${BASE_URL}/laps?session_key=${sessionKey}&driver=${driverNumber}`);
    if (!response.ok) throw new Error('Failed to fetch lap data');
    return response.json();
}

async function getIntervals(sessionKey) {
    const response = await fetch(`${BASE_URL}/intervals?session_key=${sessionKey}`);
    if (!response.ok) throw new Error('Failed to fetch intervals');
    return response.json();
}

async function getLocation(sessionKey) {
    const response = await fetch(`${BASE_URL}/location?session_key=${sessionKey}`);
    if (!response.ok) throw new Error('Failed to fetch location data');
    return response.json();
}

async function getSessions() {
    const response = await fetch(`${BASE_URL}/sessions`);
    if (!response.ok) throw new Error('Failed to fetch sessions');
    return response.json();
}

async function getSessionKeysForDriver(driverNumber) {
    const response = await fetch(`${BASE_URL}/stints?driver_number=${driverNumber}`);
    if (!response.ok) throw new Error('Failed to fetch session keys for driver');
    const data = await response.json();
    console.log(data.session_key)
    return data.session_key; // Adjust according to the actual response structure
}

async function getPositions(sessionKey, driverNumber) {
    const response = await fetch(`${BASE_URL}/position?session_key=${sessionKey}&driver_number=${driverNumber}`);
    if (!response.ok) throw new Error('Failed to fetch positions');
    return response.json();
}
