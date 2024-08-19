// src/data.js
export async function fetchCarData(driverNumber, sessionKey, minSpeed) {
    const url = `https://api.openf1.org/v1/car_data?driver_number=${driverNumber}&session_key=${sessionKey}&speed>=${minSpeed}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching car data:', error);
        return null;
    }
}

export function processCarData(data) {
    return data.map(car => ({
        date: car.date,
        driverNumber: car.driver_number,
        speed: car.speed,
        rpm: car.rpm,
        throttle: car.throttle,
        brake: car.brake,
        gear: car.n_gear,
        drs: car.drs,
    }));
}
