FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json bunfig.toml mikro-orm.config.ts ./
COPY src ./src
EXPOSE 3000
CMD ["bun", "src/main.ts"]
