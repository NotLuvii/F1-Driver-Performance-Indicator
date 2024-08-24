from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import requests
import os

app = Flask(__name__, static_folder='public')
CORS(app)  # Enable CORS for all routes

API_BASE_URL = 'https://api.openf1.org/v1/'

@app.route('/api/<path:endpoint>', methods=['GET'])
def proxy_request(endpoint):
    response = requests.get(API_BASE_URL + endpoint)
    return jsonify(response.json())

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory(app.static_folder, filename)

if __name__ == '__main__':
    app.run(port=8000)
