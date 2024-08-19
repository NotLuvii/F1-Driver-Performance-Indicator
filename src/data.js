export async function fetchCarData(driverNumber, sessionKey, minSpeed) {
    const url = `https://api.openf1.org/v1/car_data?driver_number=${driverNumber}&session_key=${sessionKey}&speed>=${minSpeed}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('Raw API data:', data); // Log raw data
        return data;
    } catch (error) {
        console.error('Error fetching car data:', error);
        return null;
    }
}

export function processCarData(data) {
    const processedData = data.map(car => ({
        date: new Date(car.date).toISOString(), // Convert to ISO 8601 format
        driverNumber: car.driver_number,
        speed: car.speed,
        rpm: car.rpm,
        throttle: car.throttle,
        brake: car.brake,
        gear: car.n_gear,
        drs: car.drs,
    }));

    console.log('Processed data with ISO 8601 dates:', processedData); // Log processed data
    return processedData;
}
