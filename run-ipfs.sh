sudo docker run -p 5001:5001 -p 8011:8011 \
  -d --restart=always --network=host \
  ceramicnetwork/go-ipfs-daemon
