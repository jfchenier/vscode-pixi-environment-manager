#!/bin/bash
# Simulates pixi-pack self-extracting binary
# This one extracts to ./env/ (standard behavior)

mkdir -p env

cat <<EOT > env/activate.sh
#!/bin/bash
export MY_OFFLINE_VAR="Success_Nested"
echo "Offline environment (nested) activated!"
EOT

chmod +x env/activate.sh
echo "Extracted to ./env"
