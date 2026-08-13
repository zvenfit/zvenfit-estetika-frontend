(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var revealTargets = document.querySelectorAll([
    '.why-txt-wrap',
    '.services > .heading',
    '.services .tabs-menu',
    '.studio-about .image-2',
    '.studio-about .about-block',
    '.equipment > .equipment-txt-wrap',
    '.equipment-mobile > .equipment-txt-wrap',
    '.fitness-block',
    '.fitness .image-3',
    '.activity-block',
    '.brands > .h2',
    '.brands > .grid',
    '.qa > .heading',
    '.qa > .div-block',
    '.qa-mobile > .heading',
    '.qa-mobile > .div-block',
    '.footer-block',
  ].join(','));

  if (!reducedMotion && 'IntersectionObserver' in window) {
    document.documentElement.classList.add('motion-ready');

    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) {
          return;
        }

        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, {
      threshold: 0.08,
      rootMargin: '0px 0px -6% 0px',
    });

    revealTargets.forEach(function (target) {
      target.classList.add('reveal-on-scroll');
      revealObserver.observe(target);
    });
  }

  var mobileBooking = document.querySelector('.mobile-booking-cta');
  var hero = document.querySelector('.home-hero');
  var footer = document.querySelector('#contact');

  if (!mobileBooking || !hero || !footer || !('IntersectionObserver' in window)) {
    return;
  }

  var heroVisible = true;
  var footerVisible = false;

  function updateMobileBooking() {
    var shouldShow = !heroVisible && !footerVisible;
    mobileBooking.classList.toggle('is-visible', shouldShow);
    mobileBooking.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    mobileBooking.tabIndex = shouldShow ? 0 : -1;
  }

  var bookingObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.target === hero) {
        heroVisible = entry.isIntersecting;
      }

      if (entry.target === footer) {
        footerVisible = entry.isIntersecting;
      }
    });

    updateMobileBooking();
  }, { threshold: 0.01 });

  bookingObserver.observe(hero);
  bookingObserver.observe(footer);
  updateMobileBooking();
}());
