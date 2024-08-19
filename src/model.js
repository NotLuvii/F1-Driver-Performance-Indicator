// src/model.js

// Function to calculate the mean of an array
function mean(data) {
    return data.reduce((acc, val) => acc + val, 0) / data.length;
}

// Train a simple linear regression model
export function trainModel(data) {
    const x = data.map(d => d.speed);  // Independent variable (e.g., speed)
    const y = data.map(d => d.throttle);  // Dependent variable (e.g., throttle)

    const meanX = mean(x);
    const meanY = mean(y);

    let num = 0, denom = 0;
    for (let i = 0; i < x.length; i++) {
        num += (x[i] - meanX) * (y[i] - meanY);
        denom += (x[i] - meanX) ** 2;
    }

    const slope = num / denom;
    const intercept = meanY - slope * meanX;

    return { slope, intercept };
}

// Use the trained model to make predictions
export function predict(model, speed) {
    return model.slope * speed + model.intercept;
}