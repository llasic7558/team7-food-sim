from flask import Flask, jsonify, request

app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify({"status": "ok"}), 200

@app.route("/drivers/assign", methods=["POST"])
def assign_driver():
    return jsonify({
        "driver_id": "driver-1",
        "status": "assigned"
    }), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
