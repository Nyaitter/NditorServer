import PropTypes from 'prop-types';
import React from 'react';
import bindAll from 'lodash.bindall';

import Box from '../box/box.jsx';
import styles from './loupe.css';

const zoomScale = 3;

class LoupeComponent extends React.Component {
    constructor (props) {
        super(props);
        bindAll(this, [
            'setCanvas'
        ]);
    }
    componentDidMount () {
        this.draw();
    }
    componentDidUpdate (prevProps) {
        const current = this.props.colorInfo;
        const previous = prevProps && prevProps.colorInfo;
        if (!previous || previous.data !== current.data || previous.width !== current.width ||
            previous.height !== current.height || previous.color.r !== current.color.r ||
            previous.color.g !== current.color.g || previous.color.b !== current.color.b ||
            previous.color.a !== current.color.a) this.draw();
    }
    componentWillUnmount () {
        if (this.tmpCanvas) {
            this.tmpCanvas.width = 0;
            this.tmpCanvas.height = 0;
        }
        this.tmpCanvas = null;
        this.tmpContext = null;
        this.imageData = null;
    }
    draw () {
        const boxSize = 6 / zoomScale;
        const boxLineWidth = 1 / zoomScale;
        const colorRingWidth = 15 / zoomScale;

        const ctx = this.canvas.getContext('2d');
        const {color, data, width, height} = this.props.colorInfo;
        if (this.canvas.width !== zoomScale * width) this.canvas.width = zoomScale * width;
        if (this.canvas.height !== zoomScale * height) this.canvas.height = zoomScale * height;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // In order to scale the image data, must draw to a tmp canvas first
        if (!this.tmpCanvas) {
            this.tmpCanvas = document.createElement('canvas');
            this.tmpContext = this.tmpCanvas.getContext('2d');
        }
        const tmpCanvas = this.tmpCanvas;
        const tmpCtx = this.tmpContext;
        if (tmpCanvas.width !== width || tmpCanvas.height !== height || !this.imageData) {
            tmpCanvas.width = width;
            tmpCanvas.height = height;
            this.imageData = tmpCtx.createImageData(width, height);
        }
        const imageData = this.imageData;
        imageData.data.set(data);
        tmpCtx.putImageData(imageData, 0, 0);

        // Scale the loupe canvas and draw the zoomed image
        ctx.save();
        ctx.scale(zoomScale, zoomScale);
        ctx.drawImage(tmpCanvas, 0, 0, width, height);

        // Draw an outlined square at the cursor position (cursor is hidden)
        ctx.lineWidth = boxLineWidth;
        ctx.strokeStyle = 'black';
        ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
        ctx.beginPath();
        ctx.rect((width / 2) - (boxSize / 2), (height / 2) - (boxSize / 2), boxSize, boxSize);
        ctx.fill();
        ctx.stroke();

        // Draw a thick ring around the loupe showing the current color
        ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
        ctx.lineWidth = colorRingWidth;
        ctx.beginPath();
        ctx.moveTo(width, height / 2);
        ctx.arc(width / 2, height / 2, width / 2, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
    }
    setCanvas (element) {
        this.canvas = element;
    }
    render () {
        const {
            colorInfo,
            ...boxProps
        } = this.props;
        const x = colorInfo.x - ((zoomScale * colorInfo.width) / 2);
        const y = colorInfo.y - ((zoomScale * colorInfo.height) / 2);
        return (
            <Box
                {...boxProps}
                className={styles.colorPicker}
                componentRef={this.setCanvas}
                element="canvas"
                height={colorInfo.height}
                style={{
                    transform: `translate(${x}px, ${y}px)`,
                    width: colorInfo.width * zoomScale,
                    height: colorInfo.height * zoomScale
                }}
                width={colorInfo.width}
            />
        );
    }
}

LoupeComponent.propTypes = {
    colorInfo: PropTypes.shape({
        color: PropTypes.shape({
            r: PropTypes.number,
            g: PropTypes.number,
            b: PropTypes.number,
            a: PropTypes.number
        }),
        data: PropTypes.instanceOf(Uint8Array),
        width: PropTypes.number,
        height: PropTypes.number,
        x: PropTypes.number,
        y: PropTypes.number
    })
};

export default LoupeComponent;
