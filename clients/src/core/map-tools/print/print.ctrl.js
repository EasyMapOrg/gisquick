(function() {
  'use strict';

  angular
    .module('gl.print')
    .controller('PrintController', PrintController);

  function PrintController($scope, $timeout, $compile, $templateCache, $http, projectProvider, layersControl, gislabClient) {
    var tool = $scope.tool;
    var copyrightsTemplate = [
      '<div style="',
        'background-color:rgba(255,255,255,0.75);',
        'position:absolute;',
        'bottom:0;',
        'right:0;',
        'padding-left:8px;',
        'padding-right:8px;',
        'font-family:Liberation Sans;">{0}',
      '</div>'
    ].join('');

    function createPrintParameters(layout, layers, extent, options) {
      var config = tool.config;
      var overlaysLayer = projectProvider.map.getLayer('qgislayer');
      var copyrights = overlaysLayer.getSource().getAttributions().map(function(attribution) {
        return attribution.getHTML().replace('<a ', '<span ').replace('</a>', '</span>');
      }).join('');

      var params = {
        'SERVICE': 'WMS',
        'REQUEST': 'GetPrint',
        'TEMPLATE': layout.name,
        'DPI': config.dpi,
        'FORMAT': config.format,
        'SRS': projectProvider.config.projection.code,
        'LAYERS': layers.join(','),
        'map0:EXTENT': extent.join(','),
        'map0:SCALE': $scope.mapScale,
        'map0:ROTATION': config.rotation,

        'gislab_project': tool.config.title,
        'gislab_author': tool.config.author,
        'gislab_contact': tool.config.contact,
        'gislab_copyrights': copyrightsTemplate.format(copyrights)
      };
      var labels = tool.data[config.layout.name].labels;
      labels.forEach(function(label) {
        if (label.value) {
          params[label.title] = label.value;
        }
      });
      angular.extend(params, options);
      return params;
    }

    function mmToPx(value) {
      return parseInt((96 * value)/25.4);
    }

    function getPrintParameters() {
      var layout = tool.config.layout;
      var index = tool.config.layouts.indexOf(tool.config.layout);
      var layoutElem = tool._previewElem.find('print-layout')[index];

      var width = mmToPx(layout.map.width);
      var height = mmToPx(layout.map.height);
      var left = layoutElem.offsetLeft*tool.config._previewScale + mmToPx(layout.map.x);
      var top = layoutElem.offsetTop*tool.config._previewScale + mmToPx(layout.map.y);

      var center = projectProvider.map.getCoordinateFromPixel(
        [left + width/2, top + height/2]
      );
      var resolution = projectProvider.map.getView().getResolution();
      var extent = [
        center[0] - resolution * width / 2,
        center[1] - resolution * height / 2,
        center[0] + resolution * width / 2,
        center[1] + resolution * height / 2
      ];
      // rotation angle in degrees
      tool.config.rotation = projectProvider.map.getView().getRotation()*180/Math.PI;
      return createPrintParameters(
        layout,
        layersControl.getVisibleLayers(projectProvider.map),
        extent
      );
    }

    function hideToast() {
      tool.config.toast = false;
    }
    function showToast() {
      if (!tool.config.toast) {
        tool.config.toast = true;
        $timeout(hideToast, 3500);
      }
    }

    function scaleAnimation(options) {
      animationLock = true;
      var start = options.start ? options.start : Date.now();
      var duration = options.duration !== undefined ? options.duration : 450;
      var easing = options.easing ? options.easing : ol.easing.inAndOut;
      var startScale = options.from;
      var endScale = options.to;
      var mapElem = angular.element(projectProvider.map.getTargetElement());

      return function(map, frameState) {
        var t = 1;
        if (frameState.time < start + duration) {
          t = easing((frameState.time - start) / duration);
        }

        frameState.animate = false; // ol.Map.setSize will trigger rendering
        var scale = startScale+(endScale-startScale)*t;
        projectProvider.map.setSize([
          window.innerWidth*scale/100,
          window.innerHeight*scale/100,
        ]);

        if (t === 1) {
          setTimeout(function() {
            mapElem.css('width', scale+'%');
            mapElem.css('height', scale+'%');
            mapElem.css('transform', 'scale({0}, {0})'.format(100/scale));
          }, 50);

          animationLock = false;
          return false;
        } else {
          return true;
        }
      };
    }

    var animationLock = false;
    function scaleMap(percScale) {
      var currentScale = tool.config._previewScale*100;
      if (currentScale === percScale) {
        return;
      }
      if (percScale > 100) {
        showToast();
      }
      var animation = scaleAnimation({
        from: currentScale,
        to: percScale,
        duration: 450
      });
      projectProvider.map.beforeRender(animation);
      projectProvider.map.render();
      tool.config._previewScale = percScale/100;
    }

    function setupPrintLayout(printLayout, availableSize) {
      console.log('SETUP PRINT LAYOUT');
      // console.log(tool.config);
      tool.config.layout = printLayout;
      var width = mmToPx(printLayout.width);
      var height = mmToPx(printLayout.height);
      var screenSize = tool.config.screenSize;
      // console.log('Scale: '+tool.config._previewScale);
      // console.log('Available screen size: '+screenSize);
      // console.log('Template size: '+[width, height]);

      if (width > screenSize[0] || height > screenSize[1]) {
        // scale print layout preview image and map to fit screen size
        var percScale = 100 * Math.max(width/screenSize[0], height/screenSize[1]);

        tool.config.previewWidth = (width*(100/percScale))+'px';
        tool.config.previewHeight = (height*(100/percScale))+'px';
        scaleMap(percScale);
      } else {
        tool.config.previewWidth = width+'px';
        tool.config.previewHeight = height+'px';
        scaleMap(100);
      }
    }

    /** Setup scale transformation on all required map mouse events
    used in map controls - when map canvas is resized and scaled down
    to fit print layout area into device screen size. */
    function setupMapEventsTransform() {
      function transformEvent(evt) {
        var x = evt.pixel[0] * tool.config._previewScale;
        var y = evt.pixel[1] * tool.config._previewScale;

        evt.pixel[0] = x;
        evt.pixel[1] = y;
        if (evt.getPointerEvent) {
          var pointerEvent = evt.getPointerEvent();
          pointerEvent.clientX = x
          pointerEvent.clientY = y;
        }
        evt.coordinate = projectProvider.map.getCoordinateFromPixel(evt.pixel);
      }
      var zoomInteraction = projectProvider.map.getInteractionByClass(ol.interaction.DragZoom);
      if (zoomInteraction) {
        zoomInteraction._handleEvent_ = zoomInteraction.handleEvent;
        zoomInteraction.handleEvent = function(evt) {
          transformEvent(evt);
          return zoomInteraction._handleEvent_(evt);
        };
      }
    }

    /** Remove all registred event listener used for map mouse events transformation */
    function removeMapEventsTransform() {
      var zoomInteraction = projectProvider.map.getInteractionByClass(ol.interaction.DragZoom);
      if (zoomInteraction._handleEvent_) {
        zoomInteraction.handleEvent = zoomInteraction._handleEvent_;
      }
    }

    function initializePrintPreview() {
      tool.config.layouts.forEach(function(layout) {
        var extent = projectProvider.map.getView().calculateExtent([layout.map.width, layout.map.height]);
        var params = createPrintParameters(
          layout,
          [], // empty map
          extent,
          {'DPI': 96, 'FORMAT': 'png', 'map0:SCALE': '1000'}
        );
        layout.templateUrl = gislabClient.encodeUrl(projectProvider.config.ows_url, params);
      });

      $http.get(tool.previewTemplate, {cache: $templateCache})
        .then(function(response) {
          var template = response.data;
          tool._previewElem = angular.element(template);
          $compile(tool._previewElem)($scope);
          angular.element(document.body).append(tool._previewElem);
        });
    }

    tool.events.mapResized = function resizeHandler() {
      if (!animationLock) {
        setupPrintLayout(tool.config.layout);
      }
    };

    tool.events.toolActivated = function() {
      tool.events.layoutChanged = setupPrintLayout;
      if (tool._previewElem) {
        tool._previewElem.css('display', '');
      } else {
        // initializePrintPreview();
        $timeout(initializePrintPreview, 450);
      }
      var mapElem = angular.element(projectProvider.map.getTargetElement());
      mapElem.css('transform-origin', 'top left');
      setupMapEventsTransform();
      tool.config._previewScale = 1;
      if (tool.config.layout) {
        setupPrintLayout(tool.config.layout);
      }
    };

    tool.events.toolDeactivated = function() {
      tool.events.layoutChanged = angular.noop;
      tool._previewElem.css('display', 'none');
      removeMapEventsTransform();

      // reset map scale
      scaleMap(100);
      tool.config._previewScale = 1;
    };

    $scope.print = function() {
      var printParams = getPrintParameters();
      var url = gislabClient.encodeUrl(projectProvider.config.ows_url, printParams);
      var popup;
      function closePrint () {
        if (popup) {
          popup.close();  
        }
      }

      popup = window.open(url);
      popup.onbeforeunload = closePrint;
      popup.onafterprint = closePrint;
      // popup.focus(); // Required for IE
      popup.print();
    };

    $scope.download = function() {
      var printParams = getPrintParameters();
      tool.config.showProgressBar = true;
      // TODO: handle errors
      gislabClient.get(projectProvider.config.ows_url, printParams, {responseType: 'blob'})
        .then(function(data) {
          tool.config.showProgressBar = false;
          var link = document.createElement("a");
          link.download = "{0}.{1}".format(tool.config.layout.name, tool.config.format);
          link.href = URL.createObjectURL(data);
          (document.body || document.documentElement).appendChild(link);
          link.click();
          setTimeout(function() {
            (document.body || document.documentElement).removeChild(link);
            URL.revokeObjectURL(link.href);
          }, 10000);
        });
    }
  }
})();
