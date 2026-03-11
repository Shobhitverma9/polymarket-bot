# Use a lightweight Node.js base image
FROM node:18-alpine

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY *.js ./

# The bot doesn't expose any ports, so EXPOSE is not needed

# Command to run the bot
CMD ["npm", "run", "paperbot"]
