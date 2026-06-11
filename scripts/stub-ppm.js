#!/usr/bin/env node
// Stub ppm for dev environments where ppm hasn't been built yet.
// Returns safe empty responses so settings-view doesn't error on startup.
const command = process.argv[2];

if (command === 'outdated') {
  process.stdout.write('[]');
} else if (command === 'list') {
  process.stdout.write('[]');
}

process.exit(0);
