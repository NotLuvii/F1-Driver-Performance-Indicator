import { fetchCarData, processCarData } from './data.js';
import { trainModel, predict } from './model.js';
import Chart from 'chart.js/auto';

async function main() {
    const fetchButton = document.getElementById('fetchData');
    fetchButton.addEventListener('click', async () => {
        const driverNumber = document.getElementById('driverNumber').value;
        const sessionKey = document.getElementById('sessionKey').value;
        const minSpeed = document.getElementById('minSpeed').value;

        const rawData = await fetchCarData(driverNumber, sessionKey, minSpeed);
        if (!rawData) {
            console.error('Failed to load car data');
            return;
        }

        const carData = processCarData(rawData);

        // Display car data
        const carDataElement = document.getElementById('carData');
        carDataElement.textContent = JSON.stringify(carData, null, 2); // Pretty print JSON

        // Train the model and make predictions
        const model = trainModel(carData);
        const predictions = carData.map(car => ({
            date: car.date,
            speed: car.speed,
            actualThrottle: car.throttle,
            predictedThrottle: predict(model, car.speed)
        }));

        // Display predictions as a chart
        drawChart(predictions);
    });
}

function drawChart(predictions) {
    const ctx = document.getElementById('chart').getContext('2d');

    const chart = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'Actual vs Predicted Throttle',
                data: predictions.map(p => ({
                    x: p.actualThrottle,
                    y: p.predictedThrottle
                })),
                backgroundColor: 'rgba(75, 192, 192, 1)'
            }]
        },
        options: {
            scales: {
                x: { title: { display: true, text: 'Actual Throttle (%)' } },
                y: { title: { display: true, text: 'Predicted Throttle (%)' } }
            }
        }
    });
}

main();
