// ============================================================================
// $ANSEM Buy-Back & Airdrop — Dashboard JavaScript
// ============================================================================

// ============================================================================
// PARTICLES BACKGROUND
// ============================================================================

function initParticles() {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let particles = [];
  const PARTICLE_COUNT = 50;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  class Particle {
    constructor() {
      this.reset();
    }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.size = Math.random() * 2 + 0.5;
      this.speedX = (Math.random() - 0.5) * 0.3;
      this.speedY = (Math.random() - 0.5) * 0.3;
      this.opacity = Math.random() * 0.5 + 0.1;
      // Random color: cyan or purple
      this.color = Math.random() > 0.5 
        ? `rgba(0, 245, 212, ${this.opacity})`
        : `rgba(123, 47, 247, ${this.opacity})`;
    }
    update() {
      this.x += this.speedX;
      this.y += this.speedY;
      if (this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
        this.reset();
      }
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    }
  }

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push(new Particle());
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.update();
      p.draw();
    });

    // Draw connections between nearby particles
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0, 245, 212, ${0.05 * (1 - dist / 150)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(animate);
  }
  animate();
}

// ============================================================================
// NAVBAR SCROLL EFFECT
// ============================================================================

function initNavbar() {
  const navbar = document.querySelector('.navbar');
  if (!navbar) return;

  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  });

  // Mobile toggle
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      links.classList.toggle('open');
    });
  }
}

// ============================================================================
// SCROLL REVEAL ANIMATIONS
// ============================================================================

function initScrollReveal() {
  const elements = document.querySelectorAll('.animate-on-scroll, .stagger-children');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
  });

  elements.forEach(el => observer.observe(el));
}

// ============================================================================
// COUNTER ANIMATION
// ============================================================================

function animateCounter(element, target, duration = 2000, prefix = '', suffix = '') {
  const start = 0;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(start + (target - start) * eased);

    element.textContent = prefix + current.toLocaleString() + suffix;

    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}

function initCounters() {
  const counters = document.querySelectorAll('[data-counter]');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !entry.target.dataset.animated) {
        entry.target.dataset.animated = 'true';
        const target = parseInt(entry.target.dataset.counter, 10);
        const prefix = entry.target.dataset.prefix || '';
        const suffix = entry.target.dataset.suffix || '';
        animateCounter(entry.target, target, 2000, prefix, suffix);
      }
    });
  }, { threshold: 0.5 });

  counters.forEach(el => observer.observe(el));
}

// ============================================================================
// COPY CONTRACT ADDRESS
// ============================================================================

function initCopyButton() {
  const copyBtn = document.querySelector('.copy-btn');
  const contractAddr = document.querySelector('.contract-address');
  if (!copyBtn || !contractAddr) return;

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(contractAddr.textContent.trim());
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied! ✓';
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 2000);
    } catch {
      // Fallback
      const range = document.createRange();
      range.selectNode(contractAddr);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('copy');
      window.getSelection().removeAllRanges();
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied! ✓';
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 2000);
    }
  });
}

// ============================================================================
// ACTIVITY FEED (placeholder data until bot runs)
// ============================================================================

function initActivityFeed() {
  const feed = document.getElementById('activity-feed');
  if (!feed) return;

  // Placeholder activities — will be replaced with real data once the bot is live
  const activities = [
    {
      type: 'system',
      title: 'Bot Deployed',
      subtitle: 'Buy-back & airdrop bot is live and monitoring the fee wallet',
      time: 'Just now',
      icon: '🚀',
    },
    {
      type: 'system',
      title: 'Awaiting First Deposit',
      subtitle: 'Monitoring fee wallet for incoming Pump.fun creator fees...',
      time: 'Active',
      icon: '👀',
    },
  ];

  if (activities.length === 0) {
    feed.innerHTML = `
      <div class="activity-empty">
        <p>🔄 No activity yet. The bot is monitoring the fee wallet for incoming SOL.</p>
      </div>
    `;
    return;
  }

  feed.innerHTML = activities.map(activity => `
    <div class="activity-item">
      <div class="activity-icon ${activity.type}">
        ${activity.icon}
      </div>
      <div class="activity-details">
        <div class="activity-title">${activity.title}</div>
        <div class="activity-subtitle">${activity.subtitle}</div>
      </div>
      <div class="activity-meta">
        <div class="activity-time">${activity.time}</div>
        ${activity.tx ? `<a href="https://solscan.io/tx/${activity.tx}" target="_blank" rel="noopener" class="activity-link">View on Solscan ↗</a>` : ''}
      </div>
    </div>
  `).join('');
}

// ============================================================================
// SMOOTH SCROLL FOR ANCHOR LINKS
// ============================================================================

function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.querySelector(anchor.getAttribute('href'));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Close mobile nav if open
        document.querySelector('.nav-links')?.classList.remove('open');
      }
    });
  });
}

// ============================================================================
// INITIALIZE EVERYTHING
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  initNavbar();
  initScrollReveal();
  initCounters();
  initCopyButton();
  initActivityFeed();
  initSmoothScroll();

  console.log('%c$ANSEM Buy-Back & Airdrop Bot', 'color: #00f5d4; font-size: 20px; font-weight: bold;');
  console.log('%cFully transparent. Open source. Community first.', 'color: #7b2ff7; font-size: 14px;');
  console.log('%cGitHub: https://github.com/realdoomsman/ansem-buyback-bot', 'color: #6b7280; font-size: 12px;');
});
