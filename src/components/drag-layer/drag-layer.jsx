import React from 'react';
import PropTypes from 'prop-types';
import styles from './drag-layer.css';

/* eslint no-confusing-arrow: ["error", {"allowParens": true}] */
const DragLayer = ({dragging, dragType, img, currentOffset}) => {
    React.useEffect(() => {
        window.dispatchEvent(new CustomEvent('nditor-local-asset-drag', {
            detail: {dragging, dragType, img}
        }));
    }, [dragging, dragType, img]);
    return dragging ? (
        <div className={styles.dragLayer}>
            <div
                className={styles.imageWrapper}
                style={{
                    transform: `translate(${currentOffset.x}px, ${currentOffset.y}px)`
                }}
            >
                <img
                    className={styles.image}
                    src={img}
                    draggable={false}
                />
            </div>
        </div>
    ) : null;
};

DragLayer.propTypes = {
    currentOffset: PropTypes.shape({
        x: PropTypes.number.isRequired,
        y: PropTypes.number.isRequired
    }),
    dragging: PropTypes.bool.isRequired,
    dragType: PropTypes.string,
    img: PropTypes.string
};

export default DragLayer;
