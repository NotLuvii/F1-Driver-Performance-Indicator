import { fetchCarData, processCarData } from './data.js';
import { trainModel, predict } from './model.js';

async function main() {
    const fetchButton = document.getElementById('fetchData');
    fetchButton.addEventListener('click', async () => {
        const driverNumber = document.getElementById('driverNumber').value;
        const sessionKey = document.getElementById('sessionKey').value;
        const minSpeed = document.getElementById('minSpeed').value;

        console.log('Fetching data with:', { driverNumber, sessionKey, minSpeed });

        try {
            const rawData = await fetchCarData(driverNumber, sessionKey, minSpeed);
            console.log('Raw data:', rawData);

            if (!rawData || rawData.length === 0) {
                console.error('No data returned from API');
                return;
            }

            const carData = processCarData(rawData);
            console.log('Processed car data:', carData);

            // Display car data
            document.getElementById('carData').textContent = JSON.stringify(carData, null, 2);

            // Train the model and make predictions
            const model = trainModel(carData);
            const predictions = carData.map(car => ({
                date: new Date(car.date),  // Ensure dates are JavaScript Date objects
                speed: car.speed,
                actualThrottle: car.throttle,
                predictedThrottle: predict(model, car.speed)
            }));

            console.log('Predictions:', predictions); // Log predictions to check dates

            // Display predictions as a chart
            drawChart(predictions);
        } catch (error) {
            console.error('Error fetching or processing data:', error);
        }
    });
}

let chartInstance;

function drawChart(predictions) {
    const ctx = document.getElementById('chart').getContext('2d');

    // Destroy previous chart if it exists
    if (chartInstance) {
        chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
        type: 'line', // Use 'line' for line chart
        data: {
            labels: predictions.map(p => p.date), // Use date as labels for the x-axis
            datasets: [
                {
                    label: 'Actual Throttle',
                    data: predictions.map(p => ({ x: p.date, y: p.actualThrottle })),
                    borderColor: 'rgba(75, 192, 192, 1)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    fill: false
                },
                {
                    label: 'Predicted Throttle',
                    data: predictions.map(p => ({ x: p.date, y: p.predictedThrottle })),
                    borderColor: 'rgba(255, 99, 132, 1)',
                    backgroundColor: 'rgba(255, 99, 132, 0.2)',
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'minute', // Adjust as needed (e.g., 'hour', 'day')
                        tooltipFormat: 'Pp', // Display format in tooltips
                        displayFormats: {
                            minute: 'HH:mm', // Format for minutes
                            hour: 'HH:mm',   // Format for hours
                            day: 'MMM d',    // Format for days
                            week: 'MMM d',   // Format for weeks
                            month: 'MMM yyyy', // Format for months
                            quarter: '[Q]Q yyyy', // Format for quarters
                            year: 'yyyy'     // Format for years
                        }
                    },
                    title: {
                        display: true,
                        text: 'Date'
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Throttle (%)'
                    }
                }
            }
        }
    });
}


main();
